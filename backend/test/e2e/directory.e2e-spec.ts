import { CompanyMergeService } from '../../src/engine/company-merge.service';
import { createDraft, createHarness, Harness, idem, resetDb, setupCompanyWithJob, setupUser, User } from './harness';

let h: Harness;
let u: User;

beforeAll(async () => {
  h = await createHarness();
  await resetDb(h.prisma);
  u = await setupUser(h, 'dir');
});

afterAll(async () => {
  await h.close();
});

const workspaceId = () => u.candidate.workspaceId;

async function applyTo(companyId: string, jobId: string) {
  const draft = await createDraft(h, u, companyId, jobId);
  await h.http().post(`/api/v1/drafts/${draft.id}/send`).set(u.auth).set('Idempotency-Key', idem()).send({ expectedRevision: 1 }).expect(202);
  await h.worker.drain();
  return h.prisma.applicationAttempt.findFirstOrThrow({ where: { draftId: draft.id } });
}

describe('Şirketler sayfası', () => {
  let company: { id: string; name: string };
  let attemptId: string;

  beforeAll(async () => {
    const setup = await setupCompanyWithJob(h, u, { name: 'Defne Medya' });
    company = setup.company;
    const attempt = await applyTo(company.id, setup.job.id);
    attemptId = attempt.id;
    await h.prisma.inboundMessage.create({ data: { workspaceId: workspaceId(), providerMessageId: `in-${Date.now()}`, attemptId, fromEmail: `ik@${setup.domain}`, subject: 'Başvurunuz hakkında', snippet: 'Görüşmeye davet etmek isteriz', classification: 'human_reply', category: 'interview', receivedAt: new Date(Date.now() + 1000) } });
    await setupCompanyWithJob(h, u, { name: 'Boş Firma' });
  });

  it('başvurulmuş firmalar dahil tüm firmalar listelenir; son başvuru ve yanıt sayısı görünür', async () => {
    const list = (await h.http().get('/api/v1/home/directory').set(u.auth).expect(200)).body;
    const defne = list.companies.find((c: { id: string }) => c.id === company.id);
    expect(defne).toMatchObject({ applications: 1, replies: 1, openJobs: 1, newSinceApply: 0 });
    expect(defne.lastAppliedAt).toBeTruthy();
    expect(list.companies.find((c: { name: string }) => c.name === 'Boş Firma')).toMatchObject({ applications: 0, lastAppliedAt: null });
    expect(list.totals).toMatchObject({ applied: 1, replied: 1 });
  });

  it('başvurudan sonra açılan ilan "yeni ilan" sayılır; detayda ilanlar, başvuru ve yazışma sırayla gelir', async () => {
    const later = (await h.http().post('/api/v1/jobs/manual').set(u.auth).send({ platform: 'manual', companyId: company.id, title: 'Sosyal Medya Uzmanı', locationText: 'Kadıköy, İstanbul' }).expect(201)).body;
    await h.prisma.job.update({ where: { id: later.id }, data: { status: 'open', firstSeenAt: new Date(Date.now() + 5000) } });
    const list = (await h.http().get('/api/v1/home/directory').set(u.auth).expect(200)).body;
    expect(list.companies.find((c: { id: string }) => c.id === company.id).newSinceApply).toBe(1);

    const detail = (await h.http().get(`/api/v1/home/directory/${company.id}`).set(u.auth).expect(200)).body;
    expect(detail.company).toMatchObject({ id: company.id, applications: 1, replies: 1, newSinceApply: 1 });
    expect(detail.jobs.find((j: { id: string }) => j.id === later.id)).toMatchObject({ newSinceApply: true, applied: false });
    expect(detail.jobs.find((j: { applied: boolean }) => j.applied)).toBeTruthy();
    expect(detail.applications).toEqual([expect.objectContaining({ id: attemptId, replyCount: 1, subject: expect.any(String) })]);
    expect(detail.messages.map((m: { direction: string }) => m.direction)).toEqual(['in', 'out']);
    expect(detail.messages[0]).toMatchObject({ subject: 'Başvurunuz hakkında', category: 'interview' });
  });

  it('birleştirilen kaydın adı ve başvuruları kalan firmada görünür; eski kimlik kalan firmaya yönlenir', async () => {
    const twin = await setupCompanyWithJob(h, u, { name: 'Defne Medya Ajans', withJob: false });
    await h.app.get(CompanyMergeService).merge(workspaceId(), company.id, twin.company.id, { actorId: null });
    const list = (await h.http().get('/api/v1/home/directory').set(u.auth).expect(200)).body;
    expect(list.companies.some((c: { id: string }) => c.id === twin.company.id)).toBe(false);
    const detail = (await h.http().get(`/api/v1/home/directory/${twin.company.id}`).set(u.auth).expect(200)).body;
    expect(detail.company.id).toBe(company.id);
    expect(detail.company.mergedNames).toContain('Defne Medya Ajans');
  });

  it('başka çalışma alanının firması görünmez', async () => {
    const other = await setupUser(h, 'dir-other');
    await h.http().get(`/api/v1/home/directory/${company.id}`).set(other.auth).expect(404);
  });
});
