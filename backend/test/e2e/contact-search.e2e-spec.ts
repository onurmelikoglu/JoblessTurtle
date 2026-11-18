import { AiRunRequest, AiService } from '../../src/engine/ai/ai.service';
import { ResearchService } from '../../src/engine/research.service';
import { createHarness, Harness, resetDb, setupUser, User } from './harness';

let h: Harness;
let u: User;
let research: ResearchService;

const DAY_MS = 86_400_000;
const workspaceId = () => u.candidate.workspaceId as string;

beforeAll(async () => {
  h = await createHarness();
  await resetDb(h.prisma);
  u = await setupUser(h, 'adres');
  research = h.app.get(ResearchService);
});

afterAll(async () => {
  await h.close();
});

afterEach(() => {
  jest.restoreAllMocks();
});

async function firm(name: string) {
  const company = (await h.http().post('/api/v1/companies').set(u.auth).send({ name: `${name} ajans`, website: `${name}.example`, sectors: ['kreatif ajans'], district: 'Kadıköy' }).expect(201)).body;
  await h.worker.drain();
  return company as { id: string };
}

async function searchedLongAgo(companyId: string, days: number, extra: Record<string, unknown> = {}) {
  const at = new Date(Date.now() - days * DAY_MS).toISOString();
  await h.prisma.company.update({ where: { id: companyId }, data: { researchMeta: { contactsSearchedAt: at, contactsDepth: 'max', contactsVersion: 2, emptyStreak: 1, searchedWithDomain: true, ...extra } } });
}

/** Opus ile yapılan arama adres bulur, Sonnet bulamaz. */
function fakeAi(calls: AiRunRequest[]) {
  return jest.spyOn(h.app.get(AiService), 'run').mockImplementation(async (req) => {
    calls.push(req);
    const opus = req.modelOverride?.cli_claude === 'opus';
    const domain = (req.input as { company?: { domain?: string } }).company?.domain ?? 'x.example';
    const contacts = req.kind === 'company_contacts' && opus ? [{ email: `kariyer@${domain}`, roleType: 'hr', origin: 'published', sourceUrl: `https://${domain}/kariyer` }] : [];
    const output = req.kind === 'contact_review' ? { reviews: [] } : { contacts, offices: [] };
    return { status: 'succeeded', output, provider: 'cli_claude', taskId: `fake-${req.kind}`, cached: false };
  });
}

const view = async () => (await h.http().get('/api/v1/home/contact-search/settings').set(u.auth).expect(200)).body;
const save = (body: Record<string, unknown>) => h.http().put('/api/v1/home/contact-search/settings').set(u.auth).send(body);

describe('adres araması: bulunamayanlar için takvim, Opus ve ayarlar', () => {
  it('ayarlar varsayılanla gelir, kaydedilir ve yapay zekâ ayarı kaydedilince kaybolmaz', async () => {
    const first = await view();
    expect(first.settings).toEqual({ retryPlan: 'normal', opusRetry: true, opusDailyLimit: 15, retryOnNewInfo: true });
    expect(first.plans.normal).toEqual([7, 30, 90]);
    await save({ retryPlan: 'often', opusRetry: true, opusDailyLimit: 3, retryOnNewInfo: false }).expect(200);
    await save({ retryPlan: 'sometimes', opusRetry: true, opusDailyLimit: 3, retryOnNewInfo: false }).expect(400);
    await h.http().patch('/api/v1/ai/settings').set(u.auth).send({ dailyTaskLimit: 50 }).expect(200);
    expect((await view()).settings).toEqual({ retryPlan: 'often', opusRetry: true, opusDailyLimit: 3, retryOnNewInfo: false });
    await save({ retryPlan: 'normal', opusRetry: true, opusDailyLimit: 15, retryOnNewInfo: true }).expect(200);
  });

  it('günlük Opus taraması aranmış ama Opus görmemiş adressiz firmayı Opus ile arar; ikinci kez seçmez', async () => {
    const company = await firm('opustaramasi');
    await searchedLongAgo(company.id, 2);
    const calls: AiRunRequest[] = [];
    fakeAi(calls);
    expect((await view()).summary).toMatchObject({ withoutAddress: 1, awaitingOpus: 1 });
    expect(await research.scheduleOpusRetries()).toEqual({ queued: 1 });
    await h.worker.drain();
    const harvest = calls.find((c) => c.kind === 'company_contacts')!;
    expect(harvest.modelOverride).toEqual({ cli_claude: 'opus' });
    expect(harvest.onlyProviders).toEqual(['cli_claude']);
    expect(await h.prisma.contactPoint.findFirst({ where: { companyId: company.id, email: 'kariyer@opustaramasi.example' } })).not.toBeNull();
    const meta = (await h.prisma.company.findUniqueOrThrow({ where: { id: company.id } })).researchMeta as Record<string, unknown>;
    expect(meta).toMatchObject({ emptyStreak: 0 });
    expect(meta.opusSearchedAt).toBeDefined();
    expect(await research.opusCandidates(workspaceId())).toEqual([]);
  });

  it('Opus kapalıysa ne aramanın içinde ne de günlük taramada Opus kullanılır; sonuçsuz sayaç artar', async () => {
    await save({ retryPlan: 'normal', opusRetry: false, opusDailyLimit: 15, retryOnNewInfo: true }).expect(200);
    const company = await firm('opussuz');
    const calls: AiRunRequest[] = [];
    fakeAi(calls);
    await research.findDetails(company.id, null);
    expect(calls.filter((c) => c.kind === 'company_contacts').map((c) => c.modelOverride)).toEqual([undefined]);
    expect(await research.scheduleOpusRetries()).toEqual({ queued: 0 });
    const meta = (await h.prisma.company.findUniqueOrThrow({ where: { id: company.id } })).researchMeta as Record<string, unknown>;
    expect(meta).toMatchObject({ emptyStreak: 1, searchedWithDomain: true });
    expect(meta.opusSearchedAt).toBeUndefined();
    const card = (await h.http().get('/api/v1/home/companies').set(u.auth).expect(200)).body.companies.find((c: { id: string }) => c.id === company.id);
    expect(card.addressSearch).toMatchObject({ found: false, emptyStreak: 1, opusAt: null });
    expect(new Date(card.addressSearch.nextAt).getTime() - new Date(card.addressSearch.searchedAt).getTime()).toBe(7 * DAY_MS);
    await save({ retryPlan: 'normal', opusRetry: true, opusDailyLimit: 15, retryOnNewInfo: true }).expect(200);
  });

  it('Opus günlük hakkı dolunca aramanın içindeki Opus tekrarı yapılmaz', async () => {
    await save({ retryPlan: 'normal', opusRetry: true, opusDailyLimit: 1, retryOnNewInfo: true }).expect(200);
    await h.prisma.aiTask.create({ data: { workspaceId: workspaceId(), kind: 'company_contacts', provider: 'cli_claude', model: 'claude-opus-5-5', status: 'succeeded', inputHash: 'kota', prompt: 'p', input: {} } });
    const company = await firm('kotali');
    const calls: AiRunRequest[] = [];
    fakeAi(calls);
    await research.findDetails(company.id, null);
    expect(calls.filter((c) => c.kind === 'company_contacts')).toHaveLength(1);
    expect(await research.scheduleOpusRetries()).toEqual({ queued: 0 });
    await save({ retryPlan: 'normal', opusRetry: true, opusDailyLimit: 15, retryOnNewInfo: true }).expect(200);
  });

  it('bekleme süresi dolmadan da yeni ilan çıkan firma yeniden aranır', async () => {
    const company = await firm('yeniilanli');
    await searchedLongAgo(company.id, 3, { contactsDepth: 'base', emptyStreak: 2, opusSearchedAt: new Date().toISOString() });
    const calls: AiRunRequest[] = [];
    fakeAi(calls);
    expect(await research.findDetails(company.id, null)).toEqual({ status: 'skipped', reason: 'recent' });
    await h.prisma.job.create({ data: { workspaceId: workspaceId(), companyId: company.id, canonicalKey: 'yeniilanli:kreatif', title: 'Kreatif Direktör', normalizedTitle: 'kreatif direktor', status: 'open' } });
    expect(await research.findDetails(company.id, null)).toMatchObject({ status: 'succeeded' });
    expect(calls.some((c) => c.kind === 'company_contacts')).toBe(true);
  });

  it('"Eksik bilgileri araştır" beklemeden arar; Sonnet adres bulamazsa aynı firma hemen Opus ile aranır', async () => {
    const company = await firm('israrli');
    await searchedLongAgo(company.id, 2, { opusSearchedAt: new Date(Date.now() - DAY_MS).toISOString() });
    const calls: AiRunRequest[] = [];
    fakeAi(calls);
    await h.http().post('/api/v1/home/companies/missing-emails').set(u.auth).send({ companyIds: [company.id] }).expect(201);
    await h.worker.drain();
    const harvests = calls.filter((c) => c.kind === 'company_contacts');
    expect(harvests.map((c) => c.modelOverride?.cli_claude ?? 'sonnet')).toEqual(['sonnet', 'opus']);
    expect(await h.prisma.contactPoint.findFirst({ where: { companyId: company.id, email: 'kariyer@israrli.example' } })).not.toBeNull();
    const item = await h.prisma.researchBatchItem.findFirstOrThrow({ where: { companyId: company.id } });
    expect(item.state).not.toBe('skipped');
  });

  it('Sonnet adres bulursa Opus çağrılmaz', async () => {
    const company = await firm('sonnetbuldu');
    await searchedLongAgo(company.id, 2);
    const calls: AiRunRequest[] = [];
    jest.spyOn(h.app.get(AiService), 'run').mockImplementation(async (req) => {
      calls.push(req);
      const output = req.kind === 'contact_review' ? { reviews: [] } : { contacts: [{ email: 'ik@sonnetbuldu.example', roleType: 'hr', origin: 'published', sourceUrl: 'https://sonnetbuldu.example/kariyer' }], offices: [] };
      return { status: 'succeeded', output, provider: 'cli_claude', taskId: `fake-${req.kind}`, cached: false };
    });
    jest.spyOn(research as any, 'sourcePage').mockResolvedValue('ik@sonnetbuldu.example');
    await research.findDetails(company.id, null, { deep: true, force: true });
    expect(calls.filter((c) => c.kind === 'company_contacts').map((c) => c.modelOverride)).toEqual([undefined]);
  });

  it('kullanıcı firma kartından Opus ile arama isteyebilir', async () => {
    const company = await firm('elleopus');
    await searchedLongAgo(company.id, 1);
    const calls: AiRunRequest[] = [];
    fakeAi(calls);
    await h.http().post(`/api/v1/home/companies/${company.id}/details`).set(u.auth).send({ opus: true }).expect(201);
    await h.worker.drain();
    expect(calls.find((c) => c.kind === 'company_contacts')?.modelOverride).toEqual({ cli_claude: 'opus' });
  });
});
