import { AiService } from '../../src/engine/ai/ai.service';
import { remoteOkConnector } from '../../src/engine/connectors/boards';
import { IngestService } from '../../src/engine/ingest.service';
import { JobSearchService } from '../../src/engine/job-search.service';
import { ResearchService } from '../../src/engine/research.service';
import { createHarness, Harness, resetDb, setupUser, User } from './harness';

let h: Harness;
let u: User;
let jobSearch: JobSearchService;
let ingest: IngestService;

const DAY_MS = 86_400_000;
const LINKEDIN_JOB = 'https://www.linkedin.com/jobs/view/4011111111';
const workspaceOf = (user: User): string => user.candidate.workspaceId;

type Found = { title: string; company: string; url: string; location?: string | null; workMode?: string; companyDomain?: string | null; careersUrl?: string | null; applyEmail?: string | null; platform?: string };

/** Yapay zekâ yerine sabit bir ilan listesi döner; diğer görev türleri "kullanılamıyor" kalır. */
function aiFinds(listings: Found[]) {
  return jest.spyOn(h.app.get(AiService), 'run').mockImplementation(async (req) => (req.kind === 'job_search' ? { status: 'succeeded', output: { listings }, provider: 'cli_claude', taskId: `ara-${Date.now()}-${Math.random()}`, cached: false } : { status: 'unavailable', taskId: null, provider: null }));
}

/** Gerçek siteye istek atılmaz: sayfa yoklaması verilen adreslere göre taklit edilir. */
function pagesAre(states: Record<string, 'open' | 'closed'>) {
  return jest.spyOn(jobSearch, 'checkPage').mockImplementation(async (url) => {
    const state = Object.entries(states).find(([part]) => url.includes(part))?.[1];
    if (state === 'open') return { state, posting: { externalId: 'p', title: 'Sayfadaki başlık', description: 'Kampanya ekibini yönetecek.', applyEmail: 'ik@bilinenajans.example', locationText: 'Kadıköy, İstanbul' } };
    return { state: state ?? 'unverified' };
  });
}

const jobsOf = (domainOrName: string) =>
  h.prisma.job.findMany({ where: { workspaceId: workspaceOf(u), company: { OR: [{ canonicalDomain: domainOrName }, { name: domainOrName }] } }, include: { listings: true }, orderBy: { createdAt: 'asc' } });

async function homeCompany(user: User, name: string) {
  const body = (await h.http().get('/api/v1/home/companies').set(user.auth).expect(200)).body;
  return body.companies.find((c: any) => c.name === name);
}

const firstQuery = async () => Object.keys(await jobSearch.queryLog(u.profile.id))[0];

beforeAll(async () => {
  h = await createHarness();
  await resetDb(h.prisma);
  jobSearch = h.app.get(JobSearchService);
  ingest = h.app.get(IngestService);
  u = await setupUser(h, 'arayan');
  await h.app.get(ResearchService).applyDiscovery(workspaceOf(u), { companies: [{ name: 'Bilinen Ajans', domain: 'bilinenajans.example', sectors: ['kreatif ajans'], reason: 'Bilinen firma', sourceUrl: 'https://bilinenajans.example', signal: 'sector_fit' }] }, 'kesif-0');
  await h.worker.drain();
  await h.prisma.outboxEvent.deleteMany({ where: { eventType: { in: ['jobs.plan', 'jobs.search'] } } });
});

afterAll(async () => {
  await h.close();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('ilan araması: bulunan ilanlar süzülür, tekilleşir ve kaydedilir', () => {
  const found: Found[] = [
    { title: 'Kreatif Direktör', company: 'Yeni Ajans', companyDomain: 'yeniajans.example', location: 'Kadıköy, İstanbul', url: 'https://tr.linkedin.com/jobs/view/kreatif-direktor-at-yeni-ajans-4011111111?refId=abc&trackingId=1', platform: 'LinkedIn' },
    { title: 'Art Director', company: 'Bilinen Ajans Group', location: 'İstanbul', url: 'https://bilinenajans.example/kariyer/art-director?utm_source=arama', careersUrl: 'https://bilinenajans.example/kariyer' },
    { title: 'Muhasebe Uzmanı', company: 'Yeni Ajans', url: 'https://yeniajans.example/ilan/muhasebe' },
    { title: 'Creative Director', company: 'Uzak Studio', location: 'Remote — Worldwide', workMode: 'remote', url: 'https://uzak.example/jobs/1' },
    { title: 'Kreatif Direktör', company: 'Yeni Ajans', url: 'https://www.linkedin.com/jobs/search/?currentJobId=4011111111&keywords=kreatif' },
    { title: 'Creative Director', company: 'Kapalı Ajans', url: 'https://kapali.example/ilan/9' },
    { title: 'Head of Creative', company: 'Adressiz', url: 'ilan-sayfasi' },
  ];

  it('bir sorgu çalışır: uygun ilanlar kaydedilir, uygun olmayanlar ve kapanmış olan alınmaz', async () => {
    const ai = aiFinds(found);
    pagesAre({ 'bilinenajans.example': 'open', 'kapali.example': 'closed' });
    await jobSearch.plan(workspaceOf(u), { count: 1 });
    await h.worker.drain();
    expect(ai.mock.calls.filter(([req]) => req.kind === 'job_search')).toHaveLength(1);
    const input = ai.mock.calls.find(([req]) => req.kind === 'job_search')![0].input;
    expect(input).toMatchObject({ titles: ['Kreatif Direktör', 'Creative Director'], location: 'İstanbul', known: [] });
    expect(input.platforms.join(' ')).toContain('LinkedIn');
    const event = await h.prisma.learningEvent.findFirstOrThrow({ where: { kind: 'job_search' } });
    expect(event.outcome).toMatchObject({ returned: 7, accepted: 3, fresh: 2, known: 0, closed: 1, newCompanies: 1, rejected: { title: 1, remote_not_wanted: 1, url: 1 } });
    expect(await jobSearch.queryLog(u.profile.id)).toMatchObject({ [await firstQuery()]: { runs: 1, returned: 7, fresh: 2, dry: 0 } });
  });

  it('sayfası okunamayan platform ilanı teyit bekler ve otomatik başvuruya girmez; bağlantısı ilan numarasına iner', async () => {
    const [job] = await jobsOf('yeniajans.example');
    expect(job).toMatchObject({ title: 'Kreatif Direktör', status: 'unknown', lastVerifiedAt: null, channel: 'ats_form' });
    expect(job.listings.map((l) => [l.canonicalUrl, l.status, l.statusReason, l.isOfficial])).toEqual([[LINKEDIN_JOB, 'unknown', 'reported_unverified', false]]);
    const company = await homeCompany(u, 'Yeni Ajans');
    expect(company).toMatchObject({ class: 'open', matchingJobs: 1 });
    expect(company.opportunities[0]).toMatchObject({ title: 'Kreatif Direktör', category: 'needs_confirmation', scope: 'local', links: [{ kind: 'linkedin', url: LINKEDIN_JOB }] });
    expect(await h.prisma.applicationAttempt.count({ where: { workspaceId: workspaceOf(u) } })).toBe(0);
  });

  it('yeni firma keşif akışına girer; aranan unvanlar ortak kataloğa işlenir', async () => {
    const company = await h.prisma.company.findFirstOrThrow({ where: { workspaceId: workspaceOf(u), canonicalDomain: 'yeniajans.example' } });
    expect(company).toMatchObject({ origin: 'discovery', website: 'https://yeniajans.example' });
    expect(company.notes).toContain('Kreatif Direktör');
    const row = await h.prisma.catalogCompany.findUniqueOrThrow({ where: { key: 'yeniajans.example' } });
    expect(row.discoveredFor).toContain('creative director');
    expect((row.jobs as { title: string; url: string }[]).map((j) => [j.title, j.url])).toEqual([['Kreatif Direktör', LINKEDIN_JOB]]);
  });

  it('bilinen firma adının varyantı aynı firmaya bağlanır; sayfası doğrulanan ilan açık görünür, resmî kariyer sayfası takibe alınır', async () => {
    expect(await h.prisma.company.count({ where: { workspaceId: workspaceOf(u), name: { contains: 'Bilinen' } } })).toBe(1);
    const [job] = await jobsOf('bilinenajans.example');
    expect(job).toMatchObject({ title: 'Art Director', status: 'open', lastVerifiedAt: null, applyEmail: 'ik@bilinenajans.example', description: 'Kampanya ekibini yönetecek.' });
    expect(job.listings[0]).toMatchObject({ canonicalUrl: 'https://bilinenajans.example/kariyer/art-director', status: 'open' });
    const sources = await h.prisma.sourceConnector.findMany({ where: { workspaceId: workspaceOf(u), company: { canonicalDomain: 'bilinenajans.example' } } });
    expect(sources.map((s) => [s.kind, (s.config as { url: string }).url])).toEqual([['career_page', 'https://bilinenajans.example/kariyer']]);
    expect((await homeCompany(u, 'Bilinen Ajans')).opportunities[0]).toMatchObject({ category: 'adjacent_open', canEmail: true });
  });

  it('uygunsuz ve kapanmış ilanların firması oluşturulmaz; kullanıcıya bulunan ilan sayısı bildirilir', async () => {
    expect(await h.prisma.company.count({ where: { workspaceId: workspaceOf(u), name: { in: ['Uzak Studio', 'Kapalı Ajans', 'Adressiz'] } } })).toBe(0);
    expect(await h.prisma.job.count({ where: { workspaceId: workspaceOf(u), title: 'Muhasebe Uzmanı' } })).toBe(0);
    const notes = (await h.http().get('/api/v1/notifications').set(u.auth).expect(200)).body.items;
    expect(notes.find((n: any) => n.type === 'new_jobs')).toMatchObject({ title: '2 yeni ilan bulundu', body: 'Yeni Ajans — Kreatif Direktör · Bilinen Ajans Group — Art Director' });
  });

  it('ikinci tarama aynı ilanı yeni saymaz; bilinen ilanlar aramaya "tekrar yazma" diye verilir', async () => {
    const before = (await jobsOf('yeniajans.example'))[0].listings[0];
    const ai = aiFinds([found[0], { title: 'Creative Director', company: 'Yeni Ajans', url: 'https://yeniajans.example/kariyer/creative-director', location: 'İstanbul' }]);
    pagesAre({});
    expect(await jobSearch.runQuery(u.profile.id, await firstQuery())).toMatchObject({ status: 'succeeded', stats: { returned: 2, accepted: 2, fresh: 1, known: 1, newCompanies: 0 } });
    expect(ai.mock.calls[0][0].input.known).toEqual(expect.arrayContaining(['Yeni Ajans — Kreatif Direktör', 'Bilinen Ajans — Art Director']));
    const jobs = await jobsOf('yeniajans.example');
    expect(jobs).toHaveLength(1);
    expect(jobs[0].listings.map((l) => l.canonicalUrl).sort()).toEqual([LINKEDIN_JOB, 'https://yeniajans.example/kariyer/creative-director'].sort());
    const after = jobs[0].listings.find((l) => l.id === before.id)!;
    expect(after.lastSeenAt.getTime()).toBeGreaterThanOrEqual(before.lastSeenAt.getTime());
    expect(after.status).toBe('unknown');
    expect((await jobSearch.queryLog(u.profile.id))[await firstQuery()]).toMatchObject({ runs: 2, fresh: 3, dry: 0 });
  });
});

describe('ilan araması: tetikleyiciler ve kapsam', () => {
  it('"Yeniden ara" az önce çalışmamış sorguları çalıştırır; yeni ilan getirmeyen sorgu dinlenmeye alınır', async () => {
    const ai = aiFinds([]);
    await h.http().post('/api/v1/home/search').set(u.auth).expect(201);
    await h.worker.drain();
    const searches = ai.mock.calls.filter(([req]) => req.kind === 'job_search');
    expect(searches).toHaveLength(5);
    expect(new Set(searches.map(([req]) => req.input.platforms[0])).size).toBe(3);
    const log = await jobSearch.queryLog(u.profile.id);
    expect(Object.values(log).filter((q) => q.dry === 1 && q.fresh === 0)).toHaveLength(5);
    ai.mockClear();
    expect(await jobSearch.plan(workspaceOf(u), { count: 10 })).toEqual({ queued: 0 });
  });

  it('serbest metinle hedefli tarama: metin aramaya odak olarak verilir', async () => {
    const ai = aiFinds([{ title: 'Kreatif Direktör', company: 'Başkent Reklam', location: 'Çankaya, Ankara', url: 'https://baskentreklam.example/ilan/kd' }]);
    pagesAre({});
    expect((await h.http().post('/api/v1/home/search/targeted').set(u.auth).send({ query: 'Ankara reklam ajansı' }).expect(201)).body).toEqual({ queued: true });
    await h.worker.drain();
    expect(ai.mock.calls.find(([req]) => req.kind === 'job_search')![0].input).toMatchObject({ focus: 'Ankara reklam ajansı', titles: ['Kreatif Direktör', 'Creative Director'] });
    expect(await jobsOf('baskentreklam.example')).toHaveLength(0);
    expect((await jobsOf('Başkent Reklam')).map((j) => j.title)).toEqual(['Kreatif Direktör']);
    await h.http().post('/api/v1/home/search/targeted').set(u.auth).send({ query: 'a' }).expect(400);
  });

  it('yurt dışı uzaktan kapsamı açılınca uzaktan ilan panoları eklenir, kapanınca durur', async () => {
    aiFinds([]);
    const save = (patch: Record<string, unknown>) => h.http().put('/api/v1/home/profile').set(u.auth).send({ displayName: 'arayan Aday', positions: ['Kreatif Direktör', 'Creative Director'], cities: ['İstanbul (Anadolu Yakası)'], ...patch }).expect(200);
    expect((await save({ abroadRemote: true })).body.setup).toMatchObject({ abroadRemote: true, abroadRelocation: false });
    await h.worker.drain();
    const boards = () => h.prisma.sourceConnector.findMany({ where: { workspaceId: workspaceOf(u), companyId: null, kind: { in: ['remotive', 'remoteok', 'himalayas', 'arbeitnow'] } }, orderBy: { kind: 'asc' } });
    expect((await boards()).map((s) => [s.kind, s.enabled, (s.config as { terms: string[] }).terms])).toEqual([
      ['himalayas', true, ['Kreatif Direktör', 'Creative Director']],
      ['remoteok', true, ['Kreatif Direktör', 'Creative Director']],
      ['remotive', true, ['Kreatif Direktör', 'Creative Director']],
    ]);
    const queries = Object.keys(await jobSearch.queryLog(u.profile.id));
    expect(queries.some((key) => key.startsWith('remote_world:'))).toBe(true);
    await save({ abroadRemote: false });
    await h.worker.drain();
    expect((await boards()).map((s) => s.enabled)).toEqual([false, false, false]);
  });

  it('ilan panosundan yalnızca profile uyan ilanlar kaydedilir ve otomatik başvuruya girmez', async () => {
    await h.prisma.searchProfile.update({ where: { id: u.profile.id }, data: { abroadRemote: true } });
    const source = await ingest.aggregatorSource(workspaceOf(u), 'remoteok', { terms: ['Creative Director'] });
    await h.prisma.sourceConnector.update({ where: { id: source.id }, data: { enabled: true } });
    jest.spyOn(remoteOkConnector, 'collect').mockResolvedValue({
      state: 'ok',
      complete: false,
      pages: 1,
      sourceUrl: 'https://remoteok.com/api',
      listings: [
        { externalId: '1', title: 'Creative Director', companyName: 'Nomad Studio', locationText: 'Remote — Worldwide', workMode: 'remote', url: 'https://remoteok.com/remote-jobs/1' },
        { externalId: '2', title: 'Creative Director', companyName: 'Yankee Inc', locationText: 'Remote — USA Only', workMode: 'remote', url: 'https://remoteok.com/remote-jobs/2' },
        { externalId: '3', title: 'Rust Engineer', companyName: 'Nomad Studio', locationText: 'Remote', workMode: 'remote', url: 'https://remoteok.com/remote-jobs/3' },
      ],
    });
    expect(await ingest.runSource(source.id, 'manual')).toMatchObject({ seen: 1, created: 1 });
    await h.worker.drain();
    const [job] = await jobsOf('Nomad Studio');
    expect(job).toMatchObject({ title: 'Creative Director', status: 'open', workMode: 'remote', lastVerifiedAt: null, channel: 'ats_form' });
    expect(await h.prisma.company.count({ where: { workspaceId: workspaceOf(u), name: 'Yankee Inc' } })).toBe(0);
    const company = await homeCompany(u, 'Nomad Studio');
    expect(company.opportunities[0]).toMatchObject({ scope: 'remote', category: 'target_open', links: [{ kind: 'platform', url: 'https://remoteok.com/remote-jobs/1' }] });
    expect(await h.prisma.applicationAttempt.count({ where: { workspaceId: workspaceOf(u) } })).toBe(0);
  });
});

describe('ilan araması: eskiyen ilanlar', () => {
  it('yeniden görülmeyen ilan yoklanır: sayfası kapanan kapanır, yoklanamayan bir ay sonra kapanmış sayılır', async () => {
    const [linkedinJob] = await jobsOf('yeniajans.example');
    const [official] = await jobsOf('bilinenajans.example');
    const [remote] = await jobsOf('Nomad Studio');
    const age = (jobId: string, days: number) => h.prisma.jobListing.updateMany({ where: { jobId }, data: { lastSeenAt: new Date(Date.now() - days * DAY_MS) } });
    await age(linkedinJob.id, 31);
    await age(official.id, 11);
    await age(remote.id, 11);
    pagesAre({ 'bilinenajans.example': 'closed' });
    expect(await jobSearch.expireStale()).toEqual({ checked: 4, closed: 3 });
    await h.worker.drain();
    expect((await jobsOf('yeniajans.example'))[0]).toMatchObject({ status: 'closed' });
    expect((await jobsOf('bilinenajans.example'))[0].listings[0]).toMatchObject({ status: 'closed', statusReason: 'page_closed' });
    expect((await jobsOf('Nomad Studio'))[0]).toMatchObject({ status: 'open' });
    expect(await homeCompany(u, 'Yeni Ajans')).toMatchObject({ class: 'past' });
  });
});

describe('ilan araması: firma eşlemesi ve unvan geçişi', () => {
  it('aynı çekirdek ada sahip iki firma varken ya da alan adı çelişirken benzer ad eşleşmesi yapılmaz', async () => {
    const research = h.app.get(ResearchService);
    await research.applyDiscovery(
      workspaceOf(u),
      {
        companies: [
          { name: 'Orman Holding', domain: 'ormanholding.example', sectors: [], reason: 'x', sourceUrl: 'https://ormanholding.example', signal: 'sector_fit' },
          { name: 'Orman Group', domain: 'ormangroup.example', sectors: [], reason: 'x', sourceUrl: 'https://ormangroup.example', signal: 'sector_fit' },
          { name: 'Deniz Group', domain: 'denizgroup.example', sectors: [], reason: 'x', sourceUrl: 'https://denizgroup.example', signal: 'sector_fit' },
        ],
      },
      'kesif-benzer',
    );
    aiFinds([
      { title: 'Creative Director', company: 'Orman', url: 'https://ilan.example/orman/1', location: 'İstanbul' },
      { title: 'Creative Director', company: 'Deniz', companyDomain: 'denizyazilim.example', url: 'https://ilan.example/deniz/1', location: 'İstanbul' },
      { title: 'Art Director', company: 'Deniz', url: 'https://ilan.example/deniz/2', location: 'İstanbul' },
    ]);
    pagesAre({});
    expect(await jobSearch.runFocus(workspaceOf(u), 'benzer adlar')).toMatchObject({ stats: { fresh: 3, newCompanies: 2 } });
    const names = (await h.prisma.company.findMany({ where: { workspaceId: workspaceOf(u), name: { in: ['Orman', 'Deniz', 'Orman Holding', 'Orman Group', 'Deniz Group'] } }, select: { name: true, canonicalDomain: true } })).map((c) => `${c.name}:${c.canonicalDomain}`).sort();
    expect(names).toEqual(['Deniz Group:denizgroup.example', 'Deniz:denizyazilim.example', 'Orman Group:ormangroup.example', 'Orman Holding:ormanholding.example', 'Orman:null'].sort());
    expect((await jobsOf('Deniz')).map((j) => j.title).sort()).toEqual(['Art Director', 'Creative Director']);
  });

  it('unvan sadeleştirme kuralı değişince saklanan değerler bir kez yeniden hesaplanır', async () => {
    const [job] = await jobsOf('Deniz');
    await h.prisma.job.update({ where: { id: job.id }, data: { title: 'Kıdemli Mobil Uygulama Geliştirici', normalizedTitle: 'kidemli mobil uygulama gelistirici' } });
    await h.prisma.keyValue.deleteMany({ where: { key: 'jobs:normalized-title:v2' } });
    expect(await ingest.renormalizeTitles()).toEqual({ updated: 1 });
    expect((await h.prisma.job.findUniqueOrThrow({ where: { id: job.id } })).normalizedTitle).toBe('senior mobile developer');
    expect(await ingest.renormalizeTitles()).toEqual({ skipped: true });
  });
});

describe('ilan araması: ortak katalog', () => {
  it('başka hesabın bulduğu açık ilan yeni hesaba teyit bekleyen ilan olarak taşınır', async () => {
    aiFinds([{ title: 'Creative Director', company: 'Paylaşılan Ajans', companyDomain: 'paylasilan.example', location: 'Kadıköy, İstanbul', url: 'https://paylasilan.example/kariyer/cd' }]);
    pagesAre({});
    await jobSearch.runFocus(workspaceOf(u), 'paylaşılan');
    await h.worker.drain();
    jest.restoreAllMocks();
    const friend = await setupUser(h, 'arkadas');
    await h.worker.drain();
    const company = await homeCompany(friend, 'Paylaşılan Ajans');
    expect(company).toMatchObject({ class: 'open' });
    expect(company.opportunities[0]).toMatchObject({ title: 'Creative Director', category: 'needs_confirmation', links: [{ kind: 'form', url: 'https://paylasilan.example/kariyer/cd' }] });
  });
});
