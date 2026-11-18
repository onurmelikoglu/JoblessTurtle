import { ENGLISH_CV_MISSING } from '../../src/domain/application-language';
import { AiService } from '../../src/engine/ai/ai.service';
import { DraftingService, ENGLISH_TRANSLATION_FAILED } from '../../src/engine/drafting.service';
import { createDraft, createHarness, Harness, resetDb, setupCompanyWithJob, setupUser, User } from './harness';

let h: Harness;
let u: User;
const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1');
const ENGLISH_DESCRIPTION =
  'We are looking for a Creative Director to join our team. You will lead the campaign and film teams, work with clients and our strategy group, and have strong experience with brand work. Requirements: 8+ years of experience and the ability to build and grow a team.';
const ENGLISH_BODY = 'Dear Team,\n\nI would like to apply for the Creative Director role. Please find my CV attached.\n\nBest regards,\nAday';

const translateTo = (status: 'succeeded' | 'failed') =>
  jest.spyOn(h.app.get(AiService), 'run').mockImplementation(async (req) =>
    status === 'succeeded' && req.kind === 'mail_translate'
      ? ({ status: 'succeeded', output: { subject: 'Application', body: ENGLISH_BODY }, provider: 'cli_claude', taskId: `ceviri-${Date.now()}`, cached: false } as never)
      : ({ status: 'failed', taskId: null } as never),
  );

async function englishListing(name: string) {
  const { company, job } = await setupCompanyWithJob(h, u, { name, title: 'Creative Director' });
  await h.prisma.job.update({ where: { id: job.id }, data: { description: ENGLISH_DESCRIPTION } });
  return { company, job };
}

const currentRevision = async (draftId: string) => {
  const draft = await h.prisma.applicationDraft.findUniqueOrThrow({ where: { id: draftId } });
  const rev = await h.prisma.draftRevision.findUniqueOrThrow({ where: { draftId_revision: { draftId, revision: draft.currentRevision } } });
  return { draft, rev };
};

beforeAll(async () => {
  h = await createHarness();
  await resetDb(h.prisma);
  u = await setupUser(h, 'yabanci');
});

afterAll(async () => {
  await h.close();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('başvuru dili', () => {
  it('İngilizce ilana İngilizce yazılır; İngilizce CV yoksa taslak otomatik gönderilmez', async () => {
    const { company, job } = await englishListing('Global Studio');
    translateTo('succeeded');
    const created = await createDraft(h, u, company.id, job.id);
    const { draft, rev } = await currentRevision(created.id);
    expect(draft.language).toBe('en');
    expect(rev.body).toBe(ENGLISH_BODY);
    expect(rev.subject).toMatch(/^Job Application: Creative Director – /);
    expect(draft.status).toBe('needs_review');
    expect(draft.blockedReasons).toContain(ENGLISH_CV_MISSING);
  });

  it('çeviri yapılamazsa yazı Türkçe kalır ve gözden geçirmeye düşer', async () => {
    const { company, job } = await englishListing('Remote Labs');
    translateTo('failed');
    const created = await createDraft(h, u, company.id, job.id);
    const { draft, rev } = await currentRevision(created.id);
    expect(draft.language).toBe('tr');
    expect(rev.subject).toMatch(/^İş Başvurusu: /);
    expect(draft.status).toBe('needs_review');
    expect(draft.blockedReasons).toContain(ENGLISH_TRANSLATION_FAILED);
  });

  it('Türkçe ilana ve Türkiye ofisli firmaya Türkçe yazılır', async () => {
    const { company, job } = await setupCompanyWithJob(h, u, { name: 'Yerli Ajans' });
    const created = await createDraft(h, u, company.id, job.id);
    const { draft, rev } = await currentRevision(created.id);
    expect(draft.language).toBe('tr');
    expect(rev.documentIds).toEqual([u.doc.id]);
    expect(draft.blockedReasons).not.toContain(ENGLISH_CV_MISSING);
  });

  it('firma için dil seçilince dili uymayan, elle düzenlenmemiş taslaklar çeviri sırasına girer', async () => {
    const { company, job } = await setupCompanyWithJob(h, u, { name: 'Seçimli Firma' });
    const created = await createDraft(h, u, company.id, job.id);
    await h.http().put(`/api/v1/home/companies/${company.id}/language`).set(u.auth).send({ language: 'en' }).expect(200);
    const misaligned = await h.app.get(DraftingService).misalignedDrafts({ companyId: company.id }, 10);
    expect(misaligned).toEqual([{ draftId: created.id, language: 'en' }]);
    await h.http().put(`/api/v1/home/companies/${company.id}/language`).set(u.auth).send({ language: null }).expect(200);
    expect(await h.app.get(DraftingService).misalignedDrafts({ companyId: company.id }, 10)).toEqual([]);
    await h.http().put(`/api/v1/home/companies/${company.id}/language`).set(u.auth).send({ language: 'de' }).expect(400);
  });

  it('İngilizce CV varsa İngilizce yazıya o eklenir ve engel kalkar', async () => {
    const cvEn = (await h.http().post('/api/v1/documents').set(u.auth).field('candidateId', u.candidate.id).field('type', 'cv').field('language', 'en').attach('file', pdf, 'CV_EN.pdf').expect(201)).body;
    const { company, job } = await englishListing('Nordic Works');
    translateTo('succeeded');
    const created = await createDraft(h, u, company.id, job.id);
    const { draft, rev } = await currentRevision(created.id);
    expect(draft.language).toBe('en');
    expect(rev.documentIds).toEqual([cvEn.id]);
    expect(draft.blockedReasons).not.toContain(ENGLISH_CV_MISSING);
  });
});
