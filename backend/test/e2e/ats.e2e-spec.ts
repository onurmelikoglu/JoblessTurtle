import type { AtsProfile, StructuredCv } from '../../src/domain/ats';
import { AiRunRequest, AiRunResult, AiService } from '../../src/engine/ai/ai.service';
import { AutomationService } from '../../src/engine/automation.service';
import { AtsService } from '../../src/engine/ats.service';
import * as listingDetail from '../../src/engine/connectors/listing-detail';
import { chromiumPath, pdfPageCount } from '../../src/engine/cv-html-render';
import { createHarness, Harness, idem, resetDb, setupCompanyWithJob, setupUser, User } from './harness';

let h: Harness;
let u: User;

const LONG_DESCRIPTION =
  'Mobil ekibimize Flutter ile uygulama geliştirecek, Kubernetes ve Go ile servis tarafına da destek verecek, Jira ile çalışan bir ekip arkadaşı arıyoruz. En az 3 yıl deneyim beklenir.';

const originalCv: StructuredCv = {
  name: 'Deneme Aday',
  title: 'Kreatif Direktör',
  contact: { email: 'aday@aday.local', phone: null, location: 'İstanbul', links: [] },
  summary: 'Flutter ile kampanya uygulamaları geliştirdim.',
  experience: [{ company: 'Ajans', role: 'Kreatif Direktör', period: '2015 – devam', bullets: ['Flutter ve Dart ile kampanya uygulamaları'] }],
  education: [],
  skills: ['Flutter', 'Dart'],
  languages: [],
  certifications: [],
  projects: [],
};

const profileFirst: AtsProfile = { hardSkills: ['Flutter', 'Kubernetes', 'Go'], tools: ['Jira'], softSkills: [], certifications: [], languages: [], minYears: 3, education: null, titleKeywords: [] };
const profileSecond: AtsProfile = { hardSkills: ['Flutter', 'Swift', 'Kotlin', 'GraphQL'], tools: ['Figma'], softSkills: [], certifications: [], languages: [], minYears: null, education: null, titleKeywords: [] };

const LAYOUT_HTML = `<!doctype html><html><head><style>body{font-family:'Space Grotesk',sans-serif}.page{width:100%;min-height:297mm;display:grid;grid-template-columns:60mm 1fr;background:#f2f2f2}</style></head>
<body><div class="page"><aside><h3>BECERİLER</h3><ul>{{#skills}}<li>{{.}}</li>{{/skills}}</ul><h3>HOBİLER</h3><p>Tiyatro</p></aside>
<main><h1>{{name}}</h1><p>{{title}}</p><h2>HAKKIMDA</h2><p>{{summary}}</p>{{#experience}}<section><b>{{role}}</b> {{company}} {{period}}<p>{{description}}</p></section>{{/experience}}</main></div></body></html>`;

function fakeAi(profiles: Record<string, AtsProfile>, layoutHtml: string | null = null) {
  return async (req: AiRunRequest): Promise<AiRunResult> => {
    const ok = (output: unknown): AiRunResult => ({ status: 'succeeded', output, provider: 'anthropic_api', taskId: `t-${req.kind}`, cached: false });
    if (req.kind === 'cv_structure') return ok(originalCv);
    if (req.kind === 'cv_layout' && layoutHtml) return ok({ html: layoutHtml, usesPhoto: false });
    if (req.kind === 'job_ats_profile') return ok(profiles[(req.input as { title: string }).title]);
    if (req.kind === 'cv_ats_rewrite') {
      const input = req.input as { profile: AtsProfile; missing: string[] };
      const terms = [...input.profile.hardSkills, ...input.profile.tools];
      return ok({ cv: { ...originalCv, name: 'Değişmiş Ad', skills: [...new Set([...originalCv.skills, ...terms])] }, addedSkills: input.missing });
    }
    return { status: 'unavailable', taskId: null, provider: null };
  };
}

beforeAll(async () => {
  h = await createHarness();
  await resetDb(h.prisma);
  u = await setupUser(h, 'ats');
});

afterAll(async () => {
  await h.close();
});

afterEach(() => {
  jest.restoreAllMocks();
});

async function jobWithDraft(title: string) {
  const { job } = await setupCompanyWithJob(h, u, { title });
  await h.prisma.job.update({ where: { id: job.id }, data: { description: LONG_DESCRIPTION } });
  const opp = await h.prisma.opportunity.findFirstOrThrow({ where: { jobId: job.id } });
  await h.http().post('/api/v1/home/prepare').set(u.auth).send({ opportunityIds: [opp.id] }).expect(201);
  await h.worker.drain();
  return { job, opp };
}

const preview = async (opportunityId: string) => (await h.http().get(`/api/v1/home/preview/${opportunityId}`).set(u.auth).expect(200)).body;

describe('ATS uyumu ve CV iyileştirme', () => {
  let first: { job: { id: string }; opp: { id: string } };
  let mainId: string;

  it('önizleme önce hazırlar, sonra orijinal CV’nin oranını ve eksik terimleri gösterir', async () => {
    jest.spyOn(h.app.get(AiService), 'run').mockImplementation(fakeAi({ 'Creative Director': profileFirst }));
    first = await jobWithDraft('Creative Director');
    expect((await preview(first.opp.id)).draft.ats.status).toBe('preparing');
    await h.worker.drain();
    const ats = (await preview(first.opp.id)).draft.ats;
    expect(ats.status).toBe('ready');
    expect(ats.threshold).toBe(70);
    const original = ats.items.find((i: { variant: string }) => i.variant === 'original');
    expect(original).toMatchObject({ documentId: u.doc.id, attached: true });
    expect(original.score).toBeLessThan(70);
    expect(original.missing).toEqual(['Kubernetes', 'Go', 'Jira']);
  });

  it('"İyileştir" orijinali değiştirmeden ana ATS CV üretir, ekler ve oranı yükseltir', async () => {
    jest.spyOn(h.app.get(AiService), 'run').mockImplementation(fakeAi({ 'Creative Director': profileFirst }));
    const draft = (await preview(first.opp.id)).draft;
    await h.http().post(`/api/v1/home/drafts/${draft.id}/ats-improve`).set(u.auth).expect(201);
    await h.worker.drain();
    const after = (await preview(first.opp.id)).draft;
    const main = after.ats.items.find((i: { variant: string }) => i.variant === 'ats_main');
    expect(main.attached).toBe(true);
    expect(main.score).toBe(100);
    expect(main.addedSkills).toEqual(['Kubernetes', 'Go', 'Jira']);
    expect(after.ats.attachedScore).toBe(100);
    expect(after.documents.map((d: { id: string }) => d.id)).toEqual([main.documentId]);
    mainId = main.documentId;

    const stored = await h.prisma.documentVersion.findUniqueOrThrow({ where: { id: mainId } });
    expect(stored).toMatchObject({ variant: 'ats_main', parentId: u.doc.id, scanState: 'clean', mime: 'application/pdf' });
    expect((stored.content as unknown as StructuredCv).name).toBe('Deneme Aday');
    const file = await h.http().get(`/api/v1/documents/${mainId}/download`).set(u.auth).expect(200);
    expect(Buffer.from(file.body).subarray(0, 5).toString()).toBe('%PDF-');
    expect(await h.app.get(AutomationService).defaultDocumentIds(u.candidate.id)).toEqual([u.doc.id]);
  });

  it('ana ATS CV başka ilanda düşükse üzerine yazılmaz; ilana özel sürüm üretilir', async () => {
    jest.spyOn(h.app.get(AiService), 'run').mockImplementation(fakeAi({ 'Kreatif Direktör': profileSecond }));
    const second = await jobWithDraft('Kreatif Direktör');
    await preview(second.opp.id);
    await h.worker.drain();
    const draft = (await preview(second.opp.id)).draft;
    expect(draft.ats.items.find((i: { variant: string }) => i.variant === 'ats_main').score).toBeLessThan(70);
    await h.http().post(`/api/v1/home/drafts/${draft.id}/ats-improve`).set(u.auth).expect(201);
    await h.worker.drain();
    const after = (await preview(second.opp.id)).draft;
    const forJob = after.ats.items.find((i: { variant: string }) => i.variant === 'ats_job');
    expect(forJob).toMatchObject({ attached: true, score: 100 });
    expect(await h.prisma.documentVersion.count({ where: { id: mainId, variant: 'ats_main', archived: false } })).toBe(1);
    const atsDocs = (await h.http().get('/api/v1/home/ats/documents').set(u.auth).expect(200)).body;
    expect(atsDocs.map((d: { variant: string }) => d.variant).sort()).toEqual(['ats_job', 'ats_main']);

    const firstPreview = (await preview(first.opp.id)).draft;
    expect(firstPreview.availableDocuments.some((d: { id: string }) => d.id === forJob.documentId)).toBe(false);

    await h.http().post(`/api/v1/drafts/${draft.id}/send`).set(u.auth).set('Idempotency-Key', idem()).send({ expectedRevision: after.revision }).expect(202);
    await h.worker.drain();
    const sent = await h.prisma.documentVersion.findUniqueOrThrow({ where: { id: forJob.documentId } });
    expect(sent.archived).toBe(true);
    expect(sent.pendingPromotion).toBe(false);
  });

  it('ilana özel sürüm ana yapılınca eski ana sürüm arşivlenir', async () => {
    const extra = await h.prisma.documentVersion.findFirstOrThrow({ where: { variant: 'ats_job' } });
    await h.prisma.documentVersion.update({ where: { id: extra.id }, data: { archived: false } });
    await h.http().post(`/api/v1/home/documents/${extra.id}/ats-promote`).set(u.auth).expect(201);
    expect(await h.prisma.documentVersion.findUniqueOrThrow({ where: { id: extra.id } })).toMatchObject({ variant: 'ats_main', targetJobId: null });
    expect(await h.prisma.documentVersion.findUniqueOrThrow({ where: { id: mainId } })).toMatchObject({ archived: true });
  });

  it('firmaya genel başvuruda ATS oranı yoktur', async () => {
    const { company } = await setupCompanyWithJob(h, u, { withJob: false });
    const opp = await h.prisma.opportunity.findFirst({ where: { companyId: company.id } });
    if (!opp) return;
    await h.http().post('/api/v1/home/prepare').set(u.auth).send({ opportunityIds: [opp.id] }).expect(201);
    await h.worker.drain();
    expect((await preview(opp.id)).draft.ats.status).toBe('no_job');
  });
});

const withChromium = chromiumPath() ? describe : describe.skip;

withChromium('iyileştirilmiş CV orijinal tasarımla', () => {
  jest.setTimeout(120_000);
  let v: User;
  let workspaceId: string;
  let draftId: string;

  beforeAll(async () => {
    v = await setupUser(h, 'ats-layout');
    workspaceId = (await h.prisma.candidateProfile.findUniqueOrThrow({ where: { id: v.candidate.id } })).workspaceId;
  });

  async function improveFor(title: string, layoutHtml: string) {
    jest.spyOn(h.app.get(AiService), 'run').mockImplementation(fakeAi({ [title]: profileFirst }, layoutHtml));
    const { job } = await setupCompanyWithJob(h, v, { title });
    await h.prisma.job.update({ where: { id: job.id }, data: { description: LONG_DESCRIPTION } });
    const opp = await h.prisma.opportunity.findFirstOrThrow({ where: { jobId: job.id } });
    await h.http().post('/api/v1/home/prepare').set(v.auth).send({ opportunityIds: [opp.id] }).expect(201);
    await h.worker.drain();
    const at = async () => (await h.http().get(`/api/v1/home/preview/${opp.id}`).set(v.auth).expect(200)).body.draft;
    await at();
    await h.worker.drain();
    await h.http().post(`/api/v1/home/drafts/${(await at()).id}/ats-improve`).set(v.auth).expect(201);
    await h.worker.drain();
    return at();
  }

  it('şablon hatalıysa nedeni gösterilir ve CV sade ATS şablonuyla hazırlanır', async () => {
    const draft = await improveFor('Creative Director', LAYOUT_HTML.replace('</body>', '<script>x()</script></body>'));
    draftId = draft.id;
    const main = draft.ats.items.find((i: { variant: string }) => i.variant === 'ats_main');
    const file = await h.http().get(`/api/v1/documents/${main.documentId}/download`).set(v.auth).expect(200);
    expect(Buffer.from(file.body).toString('latin1')).toContain('PDFKit');
    const layouts = (await h.http().get('/api/v1/home/ats/layouts').set(v.auth).expect(200)).body;
    expect(layouts).toEqual([expect.objectContaining({ documentId: v.doc.id, state: 'failed', reason: 'şablon betik içeriyor' })]);
  });

  it('"Yeniden oluştur" şablonu hazırlar ve gönderilmemiş ATS CV’yi yerinde orijinal tasarımla yeniden çizer', async () => {
    jest.spyOn(h.app.get(AiService), 'run').mockImplementation(fakeAi({}, LAYOUT_HTML));
    const before = await h.prisma.documentVersion.findFirstOrThrow({ where: { candidateId: v.candidate.id, variant: 'ats_main', archived: false } });
    await h.http().post(`/api/v1/home/documents/${v.doc.id}/layout`).set(v.auth).expect(201);
    expect((await h.http().get('/api/v1/home/ats/layouts').set(v.auth).expect(200)).body[0].state).toBe('preparing');
    await h.worker.drain();
    const layouts = (await h.http().get('/api/v1/home/ats/layouts').set(v.auth).expect(200)).body;
    expect(layouts[0]).toMatchObject({ state: 'ready', usesPhoto: false, reason: null });

    const after = await h.prisma.documentVersion.findUniqueOrThrow({ where: { id: before.id } });
    expect(after.archived).toBe(false);
    expect(after.sha256).not.toBe(before.sha256);
    const file = await h.http().get(`/api/v1/documents/${before.id}/download`).set(v.auth).expect(200);
    const pdf = Buffer.from(file.body).toString('latin1');
    expect(pdf.startsWith('%PDF-')).toBe(true);
    expect(pdf).toContain('Skia/PDF');

    const preview = await h.http().get(`/api/v1/home/documents/${v.doc.id}/layout-preview`).set(v.auth).expect(200);
    expect(preview.headers['content-type']).toBe('application/pdf');
  });

  it('gönderilmiş ATS CV korunur; yeni görünüm ayrı sürüm olarak açılır', async () => {
    const main = await h.prisma.documentVersion.findFirstOrThrow({ where: { candidateId: v.candidate.id, variant: 'ats_main', archived: false } });
    const draft = await h.prisma.applicationDraft.findUniqueOrThrow({ where: { id: draftId } });
    await h.http().post(`/api/v1/drafts/${draftId}/send`).set(v.auth).set('Idempotency-Key', idem()).send({ expectedRevision: draft.currentRevision }).expect(202);
    await h.worker.drain();
    const attempt = await h.prisma.applicationAttempt.findFirstOrThrow({ where: { draftId } });
    expect(attempt.documentHashes).toEqual(expect.arrayContaining([expect.objectContaining({ id: main.id })]));
    const count = await h.app.get(AtsService).refreshRenders(workspaceId);
    expect(count).toBe(1);
    expect(await h.prisma.documentVersion.findUniqueOrThrow({ where: { id: main.id } })).toMatchObject({ archived: true, sha256: main.sha256 });
    const copy = await h.prisma.documentVersion.findFirstOrThrow({ where: { candidateId: v.candidate.id, variant: 'ats_main', archived: false } });
    expect(copy.id).not.toBe(main.id);
    expect(copy.content).toEqual(main.content);
  });

  it('görünüm "sade" seçilirse şablon kullanılmaz', async () => {
    const ws = await h.prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { aiSettings: true } });
    await h.prisma.workspace.update({ where: { id: workspaceId }, data: { aiSettings: { ...((ws.aiSettings ?? {}) as object), atsCvLayout: 'plain' } } });
    await h.app.get(AtsService).refreshRenders(workspaceId);
    const main = await h.prisma.documentVersion.findFirstOrThrow({ where: { candidateId: v.candidate.id, variant: 'ats_main', archived: false } });
    const file = await h.http().get(`/api/v1/documents/${main.id}/download`).set(v.auth).expect(200);
    expect(Buffer.from(file.body).toString('latin1')).toContain('PDFKit');
  });
});

describe('metni olmayan ilan', () => {
  const ISINOLSUN_URL = 'https://isinolsun.com/is-ilani/dijital-pazarlama-ve-sosyal-medya-uzmani-ornek-0iojABC';
  const PAGE_TEXT = 'E ticaret ve sosyal hesapları yönetecek, Flutter ile kampanya uygulamaları geliştirecek, Kubernetes ve Go bilen ekip arkadaşı aranmaktadır.';

  async function bareJob(title: string) {
    const { job } = await setupCompanyWithJob(h, u, { title });
    await h.prisma.jobListing.updateMany({ where: { jobId: job.id }, data: { canonicalUrl: ISINOLSUN_URL } });
    const opp = await h.prisma.opportunity.findFirstOrThrow({ where: { jobId: job.id } });
    await h.http().post('/api/v1/home/prepare').set(u.auth).send({ opportunityIds: [opp.id] }).expect(201);
    await h.worker.drain();
    return { job, opp };
  }

  it('ilan metni ilan sayfasından okunur, ilana yazılır ve oran hesaplanır', async () => {
    jest.spyOn(h.app.get(AiService), 'run').mockImplementation(fakeAi({ 'Creative Director': profileFirst }));
    const fetchSpy = jest.spyOn(listingDetail, 'fetchListingDescription').mockResolvedValue(PAGE_TEXT);
    const { job, opp } = await bareJob('Creative Director');
    expect((await preview(opp.id)).draft.ats.status).toBe('preparing');
    await h.worker.drain();
    expect(fetchSpy).toHaveBeenCalledWith(ISINOLSUN_URL);
    expect((await h.prisma.job.findUniqueOrThrow({ where: { id: job.id } })).description).toBe(PAGE_TEXT);
    expect((await preview(opp.id)).draft.ats.status).toBe('ready');
  });

  it('sayfadan da okunamazsa bir kez denenir ve "metin yok" gösterilir', async () => {
    jest.spyOn(h.app.get(AiService), 'run').mockImplementation(fakeAi({}));
    const fetchSpy = jest.spyOn(listingDetail, 'fetchListingDescription').mockResolvedValue(null);
    const { opp } = await bareJob('Kreatif Direktör');
    expect((await preview(opp.id)).draft.ats.status).toBe('preparing');
    await h.worker.drain();
    expect((await preview(opp.id)).draft.ats.status).toBe('no_description');
    await h.worker.drain();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('yeniden iyileştirme', () => {
  it('ekli ATS CV yeniden iyileştirilince yenisi eskisinin yerine geçer', async () => {
    jest.spyOn(h.app.get(AiService), 'run').mockImplementation(fakeAi({ 'Creative Director': profileFirst }));
    const w = await setupUser(h, 'ats-again');
    const { job } = await setupCompanyWithJob(h, w, { title: 'Creative Director' });
    await h.prisma.job.update({ where: { id: job.id }, data: { description: LONG_DESCRIPTION } });
    const opp = await h.prisma.opportunity.findFirstOrThrow({ where: { jobId: job.id } });
    await h.http().post('/api/v1/home/prepare').set(w.auth).send({ opportunityIds: [opp.id] }).expect(201);
    await h.worker.drain();
    const view = async () => (await h.http().get(`/api/v1/home/preview/${opp.id}`).set(w.auth).expect(200)).body.draft;
    await view();
    await h.worker.drain();
    const draftId = (await view()).id;
    await h.http().post(`/api/v1/home/drafts/${draftId}/ats-improve`).set(w.auth).expect(201);
    await h.worker.drain();
    const first = await view();
    const oldMain = first.ats.items.find((i: { variant: string }) => i.variant === 'ats_main');
    expect(oldMain.attached).toBe(true);

    await h.http().post(`/api/v1/home/drafts/${draftId}/ats-improve`).set(w.auth).expect(201);
    await h.worker.drain();
    const second = await view();
    const newMain = second.ats.items.find((i: { variant: string }) => i.variant === 'ats_main');
    expect(newMain.documentId).not.toBe(oldMain.documentId);
    expect(newMain.attached).toBe(true);
    expect(second.revision).toBeGreaterThan(first.revision);
    expect(second.documents.map((d: { id: string }) => d.id)).toEqual([newMain.documentId]);
    expect(await h.prisma.documentVersion.findUniqueOrThrow({ where: { id: oldMain.documentId } })).toMatchObject({ archived: true });
    expect(await h.prisma.documentVersion.count({ where: { candidateId: w.candidate.id, variant: 'ats_main', archived: false } })).toBe(1);
  });
});

describe('sayfa sınırı', () => {
  it('uzun yazılan CV tek sayfaya sığdırılır; ilanın istediği beceriler kalır ve yeniden yazmaya bütçe verilir', async () => {
    const longBullet = 'Kampanya uygulamalarını Flutter ile geliştirip ölçülebilir etkileşim artışı sağladım ve ekiplerle uçtan uca yürüttüm.';
    const filler = Array.from({ length: 40 }, (_, i) => `Beceri ${i + 1}`);
    const base = fakeAi({ 'Creative Director': profileFirst });
    let budget: unknown = null;
    jest.spyOn(h.app.get(AiService), 'run').mockImplementation(async (req) => {
      if (req.kind !== 'cv_ats_rewrite') return base(req);
      budget = (req.input as { budget: unknown }).budget;
      const long: StructuredCv = {
        ...originalCv,
        summary: Array.from({ length: 8 }, () => 'Flutter, Kubernetes ve Go ile çalışan deneyimli bir kreatif direktörüm.').join(' '),
        experience: originalCv.experience.map((e) => ({ ...e, bullets: Array.from({ length: 30 }, () => longBullet) })),
        skills: [...filler, 'Flutter', 'Kubernetes', 'Go', 'Jira'],
      };
      return { status: 'succeeded', output: { cv: long, addedSkills: ['Kubernetes', 'Go', 'Jira', 'Beceri 40'] }, provider: 'anthropic_api', taskId: 't-long', cached: false };
    });
    const w = await setupUser(h, 'ats-pages');
    const { job } = await setupCompanyWithJob(h, w, { title: 'Creative Director' });
    await h.prisma.job.update({ where: { id: job.id }, data: { description: LONG_DESCRIPTION } });
    const opp = await h.prisma.opportunity.findFirstOrThrow({ where: { jobId: job.id } });
    await h.http().post('/api/v1/home/prepare').set(w.auth).send({ opportunityIds: [opp.id] }).expect(201);
    await h.worker.drain();
    const view = async () => (await h.http().get(`/api/v1/home/preview/${opp.id}`).set(w.auth).expect(200)).body.draft;
    await view();
    await h.worker.drain();
    await h.http().post(`/api/v1/home/drafts/${(await view()).id}/ats-improve`).set(w.auth).expect(201);
    await h.worker.drain();

    expect(budget).toMatchObject({ maxPages: 1, maxBullets: 3 });
    const main = await h.prisma.documentVersion.findFirstOrThrow({ where: { candidateId: w.candidate.id, variant: 'ats_main', archived: false } });
    const file = await h.http().get(`/api/v1/documents/${main.id}/download`).set(w.auth).expect(200);
    expect(pdfPageCount(Buffer.from(file.body))).toBe(1);
    const stored = main.content as unknown as StructuredCv;
    expect(stored.skills).toEqual(expect.arrayContaining(['Flutter', 'Kubernetes', 'Go', 'Jira']));
    expect(stored.skills.length).toBeLessThan(44);
    expect(main.addedSkills).not.toContain('Beceri 40');
    expect(stored.experience[0].bullets.length).toBeLessThanOrEqual(3);
  });
});

describe('eşzamanlı iyileştirme', () => {
  it('toplu iyileştirmede aynı anda tek ana ATS CV kalır, diğerleri ilana özel sürüm olur', async () => {
    jest.spyOn(h.app.get(AiService), 'run').mockImplementation(fakeAi({ 'Creative Director': profileFirst }));
    const w = await setupUser(h, 'ats-race');
    const drafts: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { job } = await setupCompanyWithJob(h, w, { title: 'Creative Director' });
      await h.prisma.job.update({ where: { id: job.id }, data: { description: LONG_DESCRIPTION } });
      const opp = await h.prisma.opportunity.findFirstOrThrow({ where: { jobId: job.id } });
      await h.http().post('/api/v1/home/prepare').set(w.auth).send({ opportunityIds: [opp.id] }).expect(201);
      await h.worker.drain();
      await h.http().get(`/api/v1/home/preview/${opp.id}`).set(w.auth).expect(200);
      await h.worker.drain();
      drafts.push((await h.http().get(`/api/v1/home/preview/${opp.id}`).set(w.auth).expect(200)).body.draft.id);
    }
    const ats = h.app.get(AtsService);
    await Promise.all(drafts.map((id) => ats.improve(id, null)));
    const versions = await h.prisma.documentVersion.findMany({ where: { candidateId: w.candidate.id, variant: { in: ['ats_main', 'ats_job'] }, archived: false } });
    expect(versions.filter((d) => d.variant === 'ats_main')).toHaveLength(1);
    expect(versions.filter((d) => d.variant === 'ats_job').every((d) => d.targetJobId && d.label.includes('·'))).toBe(true);
  });
});

withChromium('orijinal tasarımda sayfa sınırı', () => {
  jest.setTimeout(180_000);

  it('taşan CV tek sayfaya alınır; özet kısalmaz, uzun unvan kesilir', async () => {
    const base = fakeAi({ 'Creative Director': profileFirst }, LAYOUT_HTML);
    const summary = 'Flutter ile kampanya uygulamaları geliştiren bir kreatif direktörüm. Kubernetes ve Go ile servis tarafına destek verdim.';
    jest.spyOn(h.app.get(AiService), 'run').mockImplementation(async (req) => {
      if (req.kind !== 'cv_ats_rewrite') return base(req);
      const long: StructuredCv = {
        ...originalCv,
        title: 'Kreatif Direktör (Creative Director) | Flutter Geliştirici | Ürün Tasarımcısı',
        summary,
        experience: originalCv.experience.map((e) => ({ ...e, bullets: Array.from({ length: 40 }, (_, i) => `Kampanya uygulamasını Flutter ile geliştirip yayına aldım, ölçülebilir etkileşim artışı sağladım (${i + 1}).`) })),
        skills: [...Array.from({ length: 30 }, (_, i) => `Uzun Adlı Yardımcı Beceri ${i + 1}`), 'Flutter', 'Kubernetes', 'Go', 'Jira'],
      };
      return { status: 'succeeded', output: { cv: long, addedSkills: ['Kubernetes', 'Go', 'Jira'] }, provider: 'anthropic_api', taskId: 't-long-layout', cached: false };
    });
    const w = await setupUser(h, 'ats-layout-pages');
    const { job } = await setupCompanyWithJob(h, w, { title: 'Creative Director' });
    await h.prisma.job.update({ where: { id: job.id }, data: { description: LONG_DESCRIPTION } });
    const opp = await h.prisma.opportunity.findFirstOrThrow({ where: { jobId: job.id } });
    await h.http().post('/api/v1/home/prepare').set(w.auth).send({ opportunityIds: [opp.id] }).expect(201);
    await h.worker.drain();
    const view = async () => (await h.http().get(`/api/v1/home/preview/${opp.id}`).set(w.auth).expect(200)).body.draft;
    await view();
    await h.worker.drain();
    await h.http().post(`/api/v1/home/drafts/${(await view()).id}/ats-improve`).set(w.auth).expect(201);
    await h.worker.drain();

    const main = await h.prisma.documentVersion.findFirstOrThrow({ where: { candidateId: w.candidate.id, variant: 'ats_main', archived: false } });
    const file = await h.http().get(`/api/v1/documents/${main.id}/download`).set(w.auth).expect(200);
    const pdf = Buffer.from(file.body);
    expect(pdf.toString('latin1')).toContain('Skia/PDF');
    expect(pdfPageCount(pdf)).toBe(1);
    const stored = main.content as unknown as StructuredCv;
    expect(stored.summary).toBe(summary);
    expect(stored.title).toBe('Kreatif Direktör');
    expect(stored.skills).toEqual(expect.arrayContaining(['Flutter', 'Kubernetes', 'Go', 'Jira']));
  });
});
