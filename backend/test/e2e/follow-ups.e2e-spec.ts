import { createDraft, createHarness, Harness, idem, resetDb, setupCompanyWithJob, setupUser, User } from './harness';

let h: Harness;
let u: User;

const clearPacing = () => h.prisma.keyValue.deleteMany({ where: { key: { startsWith: 'send:pace:' } } });

async function sentApplication(name: string) {
  const { company } = await setupCompanyWithJob(h, u, { name, withJob: false });
  const draft = await createDraft(h, u, company.id, null, { intentType: 'general_intent' });
  await h.http().patch(`/api/v1/drafts/${draft.id}`).set(u.auth).send({ revision: draft.currentRevision, toEmail: `kariyer@${name.toLowerCase().replace(/\s+/g, '')}.example` }).expect(200);
  const fresh = await h.prisma.applicationDraft.findUniqueOrThrow({ where: { id: draft.id } });
  await clearPacing();
  const res = await h.http().post(`/api/v1/drafts/${fresh.id}/send`).set(u.auth).set('Idempotency-Key', idem()).send({ expectedRevision: fresh.currentRevision }).expect(202);
  await h.worker.drain();
  return h.prisma.applicationAttempt.findUniqueOrThrow({ where: { id: res.body.applicationId } });
}

const list = async () => (await h.http().get('/api/v1/home/follow-ups').set(u.auth).expect(200)).body;

beforeAll(async () => {
  h = await createHarness();
  await resetDb(h.prisma);
  u = await setupUser(h, 'takip');
});

afterAll(async () => {
  await h.close();
});

describe('takip merkezi', () => {
  it('gönderilen başvurunun takibi listelenir; vadesini beklemeden hazırlanıp gönderilebilir', async () => {
    const attempt = await sentApplication('Takip Ajans');
    const pending = (await list()).items.find((i: any) => i.attemptId === attempt.id);
    expect(pending).toMatchObject({ state: 'pending', company: expect.stringContaining('Takip Ajans'), draft: null });
    await h.http().post(`/api/v1/home/follow-ups/${pending.id}/prepare`).set(u.auth).expect(201);
    const drafted = (await list()).items.find((i: any) => i.id === pending.id);
    expect(drafted.state).toBe('drafted');
    expect(drafted.draft.subject).toMatch(/^Re: /);
    expect(drafted.draft.toEmail).toBe(attempt.toEmail);
    await clearPacing();
    await h.http().post(`/api/v1/home/follow-ups/${pending.id}/send`).set(u.auth).expect(201);
    await h.worker.drain();
    expect((await list()).items.find((i: any) => i.id === pending.id).state).toBe('sent');
    const followUpAttempt = await h.prisma.applicationAttempt.findFirstOrThrow({ where: { draftId: drafted.draft.id } });
    expect(followUpAttempt.intentType).toBe('follow_up');
  });

  it('vazgeçilen takip kapanır ve taslağı iptal edilir', async () => {
    const attempt = await sentApplication('Vazgecilen Ajans');
    const item = (await list()).items.find((i: any) => i.attemptId === attempt.id);
    await h.http().post(`/api/v1/home/follow-ups/${item.id}/prepare`).set(u.auth).expect(201);
    await h.http().post(`/api/v1/home/follow-ups/${item.id}/skip`).set(u.auth).expect(201);
    const closed = (await list()).items.find((i: any) => i.id === item.id);
    expect(closed).toMatchObject({ state: 'cancelled', note: 'Vazgeçildi' });
    expect((await h.prisma.applicationDraft.findUniqueOrThrow({ where: { id: closed.draft.id } })).status).toBe('cancelled');
  });

  it('takip gecikmesi ayarlanır ve yeni başvuruların vadesine yansır; ayar için otomatik başvuru ayarı gerekir', async () => {
    const workspaceId = (await h.prisma.candidateProfile.findUniqueOrThrow({ where: { id: u.candidate.id } })).workspaceId;
    await h.prisma.automationPolicy.deleteMany({ where: { workspaceId } });
    await h.http().put('/api/v1/home/follow-ups/settings').set(u.auth).send({ delayDays: 3, auto: false }).expect(422);
    expect((await list()).settings).toEqual({ delayDays: 7, auto: false, hasPolicy: false });
    await h.prisma.automationPolicy.create({ data: { workspaceId, candidateId: u.candidate.id, searchProfileId: u.profile.id, mailAccountId: u.account.id, name: 'Otomatik başvuru', active: true, autoSend: false } });
    await h.http().put('/api/v1/home/follow-ups/settings').set(u.auth).send({ delayDays: 3, auto: true }).expect(200);
    expect((await list()).settings).toEqual({ delayDays: 3, auto: true, hasPolicy: true });
    const attempt = await sentApplication('Hizli Takip');
    const followUp = await h.prisma.followUp.findUniqueOrThrow({ where: { attemptId: attempt.id } });
    const days = (followUp.dueAt.getTime() - Date.now()) / 86400_000;
    expect(days).toBeGreaterThan(2);
    expect(days).toBeLessThan(6);
    await h.http().put('/api/v1/home/follow-ups/settings').set(u.auth).send({ delayDays: 1, auto: true }).expect(400);
  });
});
