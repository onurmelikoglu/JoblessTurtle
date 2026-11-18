import { AutomationService } from '../../src/engine/automation.service';
import { createHarness, Harness, resetDb, setupCompanyWithJob, setupUser, User } from './harness';

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
  await resetDb(h.prisma);
});

afterAll(async () => {
  await h.close();
});

afterEach(() => {
  jest.restoreAllMocks();
});

const BASE_SETTINGS = {
  dailyLimit: 10,
  searchEveryHours: 24,
  filterCities: [] as string[],
  filterWorkModes: [] as string[],
  filterSizes: [] as string[],
  includeUnknownWorkMode: true,
  includeUnknownSize: true,
  fMin: 60,
  qMin: 0,
  coverageMin: 0,
  companyCooldownDays: 30,
  atsAutoImprove: false,
  atsThreshold: 70,
  atsRewriteMode: 'fill_gaps',
};

describe('otomatik başvuru ayarları', () => {
  let u: User;
  let policyId: string;

  beforeAll(async () => {
    u = await setupUser(h, 'autoset');
    const p = await h
      .http()
      .post('/api/v1/policies')
      .set(u.auth)
      .send({ candidateId: u.candidate.id, searchProfileId: u.profile.id, mailAccountId: u.account.id, name: 'Oto', modeJobApplication: true, documentIds: [u.doc.id], sendImmediately: true, qMin: 0, coverageMin: 0, fMin: 60 })
      .expect(201);
    policyId = p.body.id;
    await h.http().post(`/api/v1/policies/${policyId}/activate`).set(u.auth).expect(201);
  });

  it('ayarlar ve "neye göre başvuruyor" özeti okunur', async () => {
    const view = (await h.http().get('/api/v1/home/auto-apply/settings').set(u.auth).expect(200)).body;
    expect(view.blocker).toBeNull();
    expect(view.settings).toMatchObject({ dailyLimit: 10, searchEveryHours: 24, atsThreshold: 70, atsRewriteMode: 'fill_gaps', atsCvLayout: 'original', filterCities: [] });
    expect(view.options.provinces).toHaveLength(81);
    expect(view.explain.rules.length).toBeGreaterThan(3);
  });

  it('çalışma şekli filtresi ilanı eler ve nedenini kaydeder; filtre kalkınca hazır yazı otomatik gönderilir', async () => {
    await h.http().put('/api/v1/home/auto-apply/settings').set(u.auth).send({ ...BASE_SETTINGS, filterWorkModes: ['remote'], includeUnknownWorkMode: false }).expect(200);
    await h.worker.drain();
    const { job } = await setupCompanyWithJob(h, u, { title: 'Creative Director' });
    expect(await h.prisma.applicationAttempt.count({ where: { jobId: job.id } })).toBe(0);
    const opp = await h.prisma.opportunity.findFirstOrThrow({ where: { jobId: job.id } });
    expect(opp.autoReasons).toEqual(['WORK_MODE_FILTERED']);

    const explain = (await h.http().get('/api/v1/home/auto-apply/settings').set(u.auth).expect(200)).body.explain;
    expect(explain.reasons).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'WORK_MODE_FILTERED', count: 1 })]));

    const prepared = await h.app.get(AutomationService).prepareFromHome(u.candidate.workspaceId, opp.id, null);
    expect(prepared?.draft.status).toBe('draft');

    await h.http().put('/api/v1/home/auto-apply/settings').set(u.auth).send(BASE_SETTINGS).expect(200);
    await h.worker.drain();
    const attempt = await h.prisma.applicationAttempt.findFirstOrThrow({ where: { jobId: job.id } });
    expect(attempt.sendMode).toBe('auto');
    expect(attempt.draftId).toBe(prepared!.draft.id);
  });

  it('ayar kaydı politika sürümünü değiştirmez; kuyruktaki gönderimler iptal olmaz', async () => {
    const before = await h.prisma.automationPolicy.findUniqueOrThrow({ where: { id: policyId } });
    await h.http().put('/api/v1/home/auto-apply/settings').set(u.auth).send({ ...BASE_SETTINGS, dailyLimit: 1 }).expect(200);
    const after = await h.prisma.automationPolicy.findUniqueOrThrow({ where: { id: policyId } });
    expect(after.version).toBe(before.version);
    expect(after.dailyLimit).toBe(1);
    expect(await h.prisma.applicationAttempt.count({ where: { workspaceId: u.candidate.workspaceId, state: 'cancelled' } })).toBe(0);
  });

  it('günlük sınıra takılan ilan ertesi sabahki taramada yeniden denenir', async () => {
    await h.worker.drain();
    const { job } = await setupCompanyWithJob(h, u, { title: 'Creative Director' });
    const opp = await h.prisma.opportunity.findFirstOrThrow({ where: { jobId: job.id } });
    expect(opp.autoReasons).toEqual(['DAILY_LIMIT']);
    expect(await h.prisma.applicationAttempt.count({ where: { jobId: job.id } })).toBe(0);

    await h.prisma.usageCounter.deleteMany({ where: { workspaceId: u.candidate.workspaceId, key: { startsWith: 'auto:' } } });
    const swept = await h.app.get(AutomationService).sweep(policyId, { onlyDeferred: true });
    expect(swept.evaluated).toBeGreaterThan(0);
    await h.worker.drain();
    expect(await h.prisma.applicationAttempt.count({ where: { jobId: job.id, sendMode: 'auto' } })).toBe(1);
  });

  it('arama sıklığı değişmedikçe ilan sitesi tarama aralığı değişmez; değişince eşlenir', async () => {
    const scraperHours = async () => ((await h.prisma.keyValue.findUnique({ where: { key: 'scraper:config' } }))?.value as { sources?: Record<string, { interval_hours: number }> } | null)?.sources?.kariyer_net?.interval_hours ?? 4;
    await h.http().put('/api/v1/home/auto-apply/settings').set(u.auth).send({ ...BASE_SETTINGS, dailyLimit: 5 }).expect(200);
    expect(await scraperHours()).toBe(4);
    await h.http().put('/api/v1/home/auto-apply/settings').set(u.auth).send({ ...BASE_SETTINGS, searchEveryHours: 8 }).expect(200);
    expect(await scraperHours()).toBe(8);
  });

  it('geçersiz arama aralığı reddedilir', async () => {
    await h.http().put('/api/v1/home/auto-apply/settings').set(u.auth).send({ ...BASE_SETTINGS, searchEveryHours: 3 }).expect(400);
  });
});
