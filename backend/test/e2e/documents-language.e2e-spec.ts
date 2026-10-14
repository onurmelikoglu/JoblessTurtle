import { AiService } from '../../src/engine/ai/ai.service';
import { AutomationService } from '../../src/engine/automation.service';
import { DraftingService } from '../../src/engine/drafting.service';
import { createDraft, createHarness, Harness, resetDb, setupCompanyWithJob, setupUser, User } from './harness';

let h: Harness;
let u: User;
const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1');

async function upload(type: 'cv' | 'portfolio', language: 'tr' | 'en', name: string) {
  const res = await h.http().post('/api/v1/documents').set(u.auth).field('candidateId', u.candidate.id).field('type', type).field('language', language).attach('file', pdf, name).expect(201);
  return res.body as { id: string; label: string };
}

const attachments = async (draftId: string) => {
  const draft = await h.prisma.applicationDraft.findUniqueOrThrow({ where: { id: draftId } });
  const rev = await h.prisma.draftRevision.findUniqueOrThrow({ where: { draftId_revision: { draftId, revision: draft.currentRevision } } });
  return [...rev.documentIds].sort();
};

beforeAll(async () => {
  h = await createHarness();
  await resetDb(h.prisma);
  u = await setupUser(h, 'dil');
});

afterAll(async () => {
  await h.close();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('CV ve portföyün İngilizce sürümleri', () => {
  let portfolioTr: { id: string };
  let cvEn: { id: string; label: string };
  let portfolioEn: { id: string };

  beforeAll(async () => {
    portfolioTr = await upload('portfolio', 'tr', 'portfolyo.pdf');
    cvEn = await upload('cv', 'en', 'Aday_CV_EN.pdf');
    portfolioEn = await upload('portfolio', 'en', 'Aday_Portfolio_EN.pdf');
  });

  it('İngilizce sürüm daha yeni yüklense de varsayılan ekler ve kurulum ekranı Türkçe sürümde kalır', async () => {
    expect(cvEn.label).toBe('CV EN v1');
    const home = (await h.http().get('/api/v1/home').set(u.auth).expect(200)).body;
    expect(home.setup.cv.id).toBe(u.doc.id);
    expect(home.setup.portfolio.id).toBe(portfolioTr.id);
    expect(home.setup.english).toEqual({ cv: expect.objectContaining({ id: cvEn.id, fileName: 'Aday_CV_EN.pdf' }), portfolio: expect.objectContaining({ id: portfolioEn.id }) });
    expect((await h.app.get(AutomationService).defaultDocumentIds(u.candidate.id)).sort()).toEqual([u.doc.id, portfolioTr.id].sort());
    expect((await h.app.get(DraftingService).defaultDocuments(u.candidate.id, 'en')).sort()).toEqual([cvEn.id, portfolioEn.id].sort());
  });

  it('yazı İngilizceye çevrilince ekler İngilizce sürümlere, Türkçeye dönünce Türkçe sürümlere geçer', async () => {
    const { company } = await setupCompanyWithJob(h, u, { withJob: false });
    const draft = await createDraft(h, u, company.id, null, { intentType: 'general_intent', documentIds: [u.doc.id, portfolioTr.id] });
    jest.spyOn(h.app.get(AiService), 'run').mockImplementation(async (req) => ({
      status: 'succeeded',
      output: req.input.targetLanguage === 'en' ? { subject: 'Application', body: 'Dear team, please find my CV attached.' } : { subject: 'Başvuru', body: 'Merhaba, CV’m ektedir.' },
      provider: 'cli_claude',
      taskId: `ceviri-${Date.now()}`,
      cached: false,
    }));
    const drafting = h.app.get(DraftingService);
    expect(await drafting.translateDraft(draft.id, 'en', null)).toEqual({ status: 'succeeded' });
    expect(await attachments(draft.id)).toEqual([cvEn.id, portfolioEn.id].sort());
    expect(await drafting.translateDraft(draft.id, 'tr', null)).toEqual({ status: 'succeeded' });
    expect(await attachments(draft.id)).toEqual([u.doc.id, portfolioTr.id].sort());
  });

  it('İngilizce sürümü olmayan ek çeviride yerinde kalır', async () => {
    const { company } = await setupCompanyWithJob(h, u, { withJob: false });
    const other = await h.http().post('/api/v1/documents').set(u.auth).field('candidateId', u.candidate.id).field('type', 'other').attach('file', pdf, 'sertifika.pdf').expect(201);
    const draft = await createDraft(h, u, company.id, null, { intentType: 'general_intent', documentIds: [u.doc.id, other.body.id] });
    jest.spyOn(h.app.get(AiService), 'run').mockResolvedValue({ status: 'succeeded', output: { subject: 'Application', body: 'Dear team, please find my CV attached.' }, provider: 'cli_claude', taskId: 'ceviri-diger', cached: false } as never);
    await h.app.get(DraftingService).translateDraft(draft.id, 'en', null);
    expect(await attachments(draft.id)).toEqual([cvEn.id, other.body.id].sort());
  });

  it('dil yalnızca Türkçe ya da İngilizce olabilir', async () => {
    await h.http().post('/api/v1/documents').set(u.auth).field('candidateId', u.candidate.id).field('type', 'cv').field('language', 'de').attach('file', pdf, 'cv.pdf').expect(400);
  });
});
