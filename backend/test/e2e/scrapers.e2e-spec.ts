import { readFileSync } from 'fs';
import { join } from 'path';
import { AiService } from '../../src/engine/ai/ai.service';
import { ScraperService } from '../../src/engine/scraper.service';
import { PageFetcher } from '../../src/engine/scrapers/types';
import { createHarness, Harness, resetDb, setupUser, User } from './harness';

let h: Harness;
let admin: User;
let member: User;
let scraper: ScraperService;

const fixture = (name: string) => readFileSync(join(__dirname, '..', 'unit', 'fixtures', 'scrapers', name), 'utf8');
const KARIYER = 'https://www.kariyer.net';
const INDEED = 'https://tr.indeed.com';
const ROBOTS = 'User-agent: *\nDisallow: /filtre\n';

interface Card {
  id: number;
  title: string;
  company: string;
  location?: string;
  type?: string;
}

/** Kariyer.net sonuç sayfası; işaretleme gerçek sayfanın yapısıyla aynıdır (bkz. fixtures/scrapers). */
function kariyerPage(city: string, page: number, cards: Card[], hasNext: boolean) {
  const items = cards
    .map(
      (c) =>
        `<div data-test="list-items" class="list-items"><div data-test="ad-card" jobDateStatus="Default" workModelText="İş Yerinde" workTypeText="${c.type ?? 'Tam zamanlı'}" cityName="${city}" class="job-list-card-item"><div><a href="/is-ilani/ilan-${c.id}" data-test="ad-card-item" class="k-ad-card"><div data-test="ad-card-top"><div data-test="title-wrapper"><span data-test="ad-card-title">${c.title}</span><div data-test="subtitle-section"><span data-test="subtitle">${c.company}</span></div><div data-test="job-detail"><span data-test="location">${c.location ?? city}</span></div></div></div><div data-test="ad-date"><span><i>update</i> Bugün</span></div></a></div></div></div>`,
    )
    .join('');
  const slug = city === 'İstanbul' ? 'istanbul' : city.toLowerCase();
  const next = hasNext ? `<a href="/is-ilanlari/${slug}-${page + 1}">${page + 1}</a>` : '';
  return `<!doctype html><html lang="tr"><head><title>${city} İş İlanları</title></head><body><div class="list-items-wrapper">${items}</div><nav>${next}</nav></body></html>`;
}

type Route = { status: number; text: string; headers?: Record<string, string> } | (() => { status: number; text: string; headers?: Record<string, string> });

/** Adres → yanıt tablosu; tabloda olmayan adrese istek testi düşürür (gerçek siteye istek atılmaz). */
function serve(routes: Record<string, Route>) {
  const calls: string[] = [];
  const fetcher: PageFetcher = async (url) => {
    calls.push(url);
    if (url.endsWith('/robots.txt')) return { status: 200, url, headers: {}, text: ROBOTS };
    const route = routes[url];
    if (!route) throw new Error(`Beklenmeyen istek: ${url}`);
    const r = typeof route === 'function' ? route() : route;
    return { status: r.status, url, headers: r.headers ?? {}, text: r.text };
  };
  scraper.fetcher = fetcher;
  return calls;
}

const ok = (text: string) => ({ status: 200, text });
const kn = (path: string) => `${KARIYER}/is-ilanlari/${path}`;
const runs = (source?: string) => h.prisma.scraperRun.findMany({ where: source ? { source } : {}, orderBy: { queuedAt: 'asc' } });
const workspaceOf = (u: User) => u.candidate.workspaceId as string;

async function config(patch: Record<string, unknown>) {
  await h.http().post('/api/v1/scrapers/config').set(admin.auth).send(patch).expect(201);
}

async function runNow(body: Record<string, unknown>) {
  const res = await h.http().post('/api/v1/scrapers/run').set(admin.auth).send(body).expect(202);
  await h.worker.drain();
  return res.body.runs as { id: string; source: string; already_running: boolean }[];
}

const finished = (id: string) => h.http().get(`/api/v1/scrapers/history/${id}`).set(admin.auth).expect(200).then((r) => r.body);

beforeAll(async () => {
  h = await createHarness();
  await resetDb(h.prisma);
  scraper = h.app.get(ScraperService);
  scraper.sleep = async () => undefined;
  admin = await setupUser(h, 'yonetici');
  member = await setupUser(h, 'uye');
  await h.worker.drain();
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  jest.spyOn(h.app.get(AiService), 'run').mockResolvedValue({ status: 'unavailable', taskId: null, provider: null } as never);
  await h.prisma.scraperRun.deleteMany();
  await h.prisma.scrapedJob.deleteMany();
  await h.prisma.keyValue.deleteMany({ where: { key: 'scraper:config' } });
  await config({ cities: ['İstanbul'], sources: { kariyer_net: { max_pages: 3 } } });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('tarama çalışması ve tekilleştirme', () => {
  const PAGE1: Card[] = [
    { id: 4600001, title: 'Kreatif Direktör', company: 'Kabuk Ajans' },
    { id: 4600002, title: 'Muhasebe Uzmanı', company: 'Defter Ltd.' },
  ];
  const PAGE2: Card[] = [
    { id: 4600003, title: 'Art Director', company: 'Yosun Reklam', location: 'İstanbul(Asya) - Kadıköy' },
    { id: 4600001, title: 'Kreatif Direktör', company: 'Kabuk Ajans' },
  ];

  it('sayfaları dolaşır, ilanları standart modelle kaydeder ve ölçümleri tutar', async () => {
    const calls = serve({ [kn('istanbul')]: ok(kariyerPage('İstanbul', 1, PAGE1, true)), [kn('istanbul-2')]: ok(kariyerPage('İstanbul', 2, PAGE2, false)) });
    const [queued] = await runNow({ source: 'kariyer_net' });
    const run = await finished(queued.id);
    expect(run).toMatchObject({ source: 'kariyer_net', trigger: 'manual', state: 'succeeded', cities: ['İstanbul'], pages_visited: 2, pages_failed: 0, listings_found: 3, listings_new: 3, listings_updated: 0, errors: [] });
    expect(run.started_at && run.finished_at).toBeTruthy();
    expect(calls).toEqual([`${KARIYER}/robots.txt`, kn('istanbul'), kn('istanbul-2')]);

    const list = await h.http().get('/api/v1/scrapers/jobs?source=kariyer_net').set(member.auth).expect(200);
    expect(list.body.total).toBe(3);
    const art = list.body.items.find((j: any) => j.job_title === 'Art Director');
    expect(art).toMatchObject({ source: 'kariyer_net', external_id: '4600003', company_name: 'Yosun Reklam', city: 'İstanbul', district: 'Kadıköy', job_url: `${KARIYER}/is-ilani/ilan-4600003`, employment_type: 'Tam zamanlı', work_mode: 'onsite', status: 'active', company_url: null, description: null });
    expect(art.first_seen_at).toBe(art.last_seen_at);
  });

  it('aynı ilan yeniden bulunduğunda yeni kayıt açılmaz; içerik değişirse güncellenir', async () => {
    serve({ [kn('istanbul')]: ok(kariyerPage('İstanbul', 1, PAGE1, false)) });
    await runNow({ source: 'kariyer_net' });
    const before = await h.prisma.scrapedJob.findMany({ orderBy: { externalId: 'asc' } });

    serve({ [kn('istanbul')]: ok(kariyerPage('İstanbul', 1, PAGE1, false)) });
    const [second] = await runNow({ source: 'kariyer_net' });
    expect(await finished(second.id)).toMatchObject({ state: 'succeeded', listings_found: 2, listings_new: 0, listings_updated: 0 });
    const after = await h.prisma.scrapedJob.findMany({ orderBy: { externalId: 'asc' } });
    expect(after).toHaveLength(2);
    expect(after.map((j) => j.firstSeenAt.getTime())).toEqual(before.map((j) => j.firstSeenAt.getTime()));
    expect(after[0].lastSeenAt.getTime()).toBeGreaterThan(before[0].lastSeenAt.getTime());
    expect(after[0].lastRunId).toBe(second.id);

    serve({ [kn('istanbul')]: ok(kariyerPage('İstanbul', 1, [{ ...PAGE1[0], type: 'Yarı zamanlı' }, PAGE1[1]], false)) });
    const [third] = await runNow({ source: 'kariyer_net' });
    expect(await finished(third.id)).toMatchObject({ listings_new: 0, listings_updated: 1 });
    const changed = await h.prisma.scrapedJob.findUniqueOrThrow({ where: { source_externalId: { source: 'kariyer_net', externalId: '4600001' } } });
    expect(changed).toMatchObject({ employmentType: 'Yarı zamanlı' });
    expect(changed.contentChangedAt).not.toBeNull();
    expect(await h.prisma.scrapedJob.count()).toBe(2);
  });

  it('farklı numarayla yeniden yayımlanan ilan yeni sayılmaz ve ana kayda bağlanır', async () => {
    serve({ [kn('istanbul')]: ok(kariyerPage('İstanbul', 1, PAGE1, false)) });
    await runNow({ source: 'kariyer_net' });
    serve({ [kn('istanbul')]: ok(kariyerPage('İstanbul', 1, [{ id: 4600099, title: 'Kreatif  direktör', company: 'KABUK AJANS' }], false)) });
    const [run] = await runNow({ source: 'kariyer_net' });
    expect(await finished(run.id)).toMatchObject({ listings_new: 0, duplicates: 1 });
    const original = await h.prisma.scrapedJob.findUniqueOrThrow({ where: { source_externalId: { source: 'kariyer_net', externalId: '4600001' } } });
    const repost = await h.prisma.scrapedJob.findUniqueOrThrow({ where: { source_externalId: { source: 'kariyer_net', externalId: '4600099' } } });
    expect(repost.duplicateOfId).toBe(original.id);
    const listed = await h.http().get('/api/v1/scrapers/jobs').set(admin.auth).expect(200);
    expect(listed.body.items.map((j: any) => j.external_id)).not.toContain('4600099');
    const withDuplicates = await h.http().get('/api/v1/scrapers/jobs?include_duplicates=true').set(admin.auth).expect(200);
    expect(withDuplicates.body.items.map((j: any) => j.external_id)).toContain('4600099');
  });

  it('uzun süre görülmeyen ilan silinmez: önce missing, sonra expired; yeniden görülünce active', async () => {
    serve({ [kn('istanbul')]: ok(kariyerPage('İstanbul', 1, PAGE1, false)) });
    await runNow({ source: 'kariyer_net' });
    const gone = { source_externalId: { source: 'kariyer_net', externalId: '4600002' } };
    await h.prisma.scrapedJob.update({ where: gone, data: { lastSeenAt: new Date(Date.now() - 3 * 86_400_000) } });
    serve({ [kn('istanbul')]: ok(kariyerPage('İstanbul', 1, [PAGE1[0]], false)) });
    await runNow({ source: 'kariyer_net' });
    expect((await h.prisma.scrapedJob.findUniqueOrThrow({ where: gone })).status).toBe('missing');
    await h.prisma.scrapedJob.update({ where: gone, data: { lastSeenAt: new Date(Date.now() - 20 * 86_400_000) } });
    serve({ [kn('istanbul')]: ok(kariyerPage('İstanbul', 1, [PAGE1[0]], false)) });
    await runNow({ source: 'kariyer_net' });
    expect((await h.prisma.scrapedJob.findUniqueOrThrow({ where: gone })).status).toBe('expired');
    serve({ [kn('istanbul')]: ok(kariyerPage('İstanbul', 1, PAGE1, false)) });
    const [back] = await runNow({ source: 'kariyer_net' });
    expect(await finished(back.id)).toMatchObject({ listings_new: 0, listings_updated: 1 });
    expect((await h.prisma.scrapedJob.findUniqueOrThrow({ where: gone })).status).toBe('active');
  });

  it('anahtar kelime Kariyer.net için yerelde süzülür', async () => {
    serve({ [kn('istanbul')]: ok(kariyerPage('İstanbul', 1, PAGE1, false)) });
    const [run] = await runNow({ source: 'kariyer_net', keywords: ['kreatif'] });
    expect(await finished(run.id)).toMatchObject({ state: 'succeeded', keywords: ['kreatif'], listings_found: 1 });
    expect((await h.prisma.scrapedJob.findMany()).map((j) => j.jobTitle)).toEqual(['Kreatif Direktör']);
  });
});

describe('çalışma alanlarına aktarım', () => {
  it('profile uyan yeni ilan "Kariyer.net taraması" kaynağıyla eklenir; uymayan ve adı gizli firma eklenmez', async () => {
    serve({
      [kn('istanbul')]: ok(
        kariyerPage(
          'İstanbul',
          1,
          [
            { id: 4700001, title: 'Kreatif Direktör', company: 'Midye Ajans' },
            { id: 4700002, title: 'Muhasebe Uzmanı', company: 'Defter Ltd.' },
            { id: 4700003, title: 'Creative Director', company: 'Gizli Firma' },
          ],
          false,
        ),
      ),
    });
    const [run] = await runNow({ source: 'kariyer_net' });
    const done = await finished(run.id);
    expect(done.state).toBe('succeeded');
    expect(done.forwarded).toBeGreaterThanOrEqual(1);
    for (const u of [admin, member]) {
      const jobs = await h.prisma.job.findMany({ where: { workspaceId: workspaceOf(u) }, include: { company: true, listings: { include: { source: true } } } });
      const scraped = jobs.filter((j) => j.listings.some((l) => l.source.kind === 'scrape_kariyer_net' && l.canonicalUrl?.includes('/ilan-47')));
      expect(scraped.map((j) => [j.title, j.company.name])).toEqual([['Kreatif Direktör', 'Midye Ajans']]);
      expect(scraped[0].listings[0].canonicalUrl).toBe(`${KARIYER}/is-ilani/ilan-4700001`);
      const note = await h.prisma.notification.findFirst({ where: { workspaceId: workspaceOf(u), type: 'new_jobs' }, orderBy: { createdAt: 'desc' } });
      expect(note?.title).toBe('Kariyer.net taraması: 1 yeni ilan eklendi');
    }

    serve({ [kn('istanbul')]: ok(kariyerPage('İstanbul', 1, [{ id: 4700001, title: 'Kreatif Direktör', company: 'Midye Ajans' }], false)) });
    await runNow({ source: 'kariyer_net' });
    const again = await h.prisma.job.count({ where: { workspaceId: workspaceOf(admin), title: 'Kreatif Direktör', company: { name: 'Midye Ajans' } } });
    expect(again).toBe(1);
  });
});

describe('engel, hız sınırı ve düzen değişikliği', () => {
  it('403/CAPTCHA taramayı durdurur; o ana kadar alınanlar kalır, sahte sonuç üretilmez, yönetici bir kez uyarılır', async () => {
    const calls = serve({
      [kn('istanbul')]: ok(kariyerPage('İstanbul', 1, [{ id: 4800001, title: 'Kreatif Direktör', company: 'Kabuk Ajans' }], true)),
      [kn('istanbul-2')]: { status: 403, text: fixture('kariyer-net-blocked.html') },
    });
    await config({ cities: ['İstanbul', 'Ankara'] });
    const [run] = await runNow({ source: 'kariyer_net' });
    const done = await finished(run.id);
    expect(done).toMatchObject({ state: 'blocked', pages_visited: 1, pages_failed: 1, listings_found: 1, listings_new: 1 });
    expect(done.errors).toEqual([expect.objectContaining({ kind: 'blocked', status: 403, city: 'İstanbul', page: 2 })]);
    expect(done.error_summary).toContain('px-captcha');
    expect(calls).not.toContain(kn('ankara'));

    const admins = await h.prisma.notification.findMany({ where: { workspaceId: workspaceOf(admin), type: 'source_blocked' } });
    expect(admins.map((n) => n.title)).toEqual(['Kariyer.net taraması: erişimi engelledi']);
    expect(await h.prisma.notification.count({ where: { workspaceId: workspaceOf(member), type: 'source_blocked' } })).toBe(0);

    const status = await h.http().get('/api/v1/scrapers/status').set(admin.auth).expect(200);
    const kariyer = status.body.sources.find((s: any) => s.source === 'kariyer_net');
    expect(kariyer.health).toBe('blocked');
    expect(new Date(kariyer.next_run_at).getTime()).toBeGreaterThanOrEqual(new Date(done.finished_at).getTime() + 24 * 3600_000 - 1000);

    serve({ [kn('istanbul')]: { status: 403, text: fixture('kariyer-net-blocked.html') } });
    await runNow({ source: 'kariyer_net' });
    expect(await h.prisma.notification.count({ where: { workspaceId: workspaceOf(admin), type: 'source_blocked' } })).toBe(1);
  });

  it('bir sitenin engeli diğer sitenin çalışmasını etkilemez', async () => {
    serve({
      [kn('istanbul')]: { status: 403, text: fixture('kariyer-net-blocked.html') },
      [`${INDEED}/jobs?q=&l=%C4%B0stanbul&sort=date`]: ok(fixture('indeed-search.html')),
    });
    const queued = await runNow({ source: 'all' });
    const bySource = Object.fromEntries(await Promise.all(queued.map(async (r) => [r.source, await finished(r.id)])));
    expect(bySource.kariyer_net.state).toBe('blocked');
    expect(bySource.indeed).toMatchObject({ state: 'succeeded', listings_found: 4, listings_new: 4 });
    const indeedJob = await h.http().get('/api/v1/scrapers/jobs?source=indeed&city=Kağıthane').set(admin.auth).expect(200);
    expect(indeedJob.body.items[0]).toMatchObject({ job_url: `${INDEED}/viewjob?jk=a1b2c3d4e5f60001`, city: 'İstanbul', district: 'Kağıthane', company_url: `${INDEED}/cmp/Kaplumbaga-Yazilim` });
  });

  it('Cloudflare doğrulama sayfası 200 dönse bile engel sayılır', async () => {
    serve({ [`${INDEED}/jobs?q=&l=%C4%B0stanbul&sort=date`]: ok(fixture('indeed-blocked.html')) });
    const [run] = await runNow({ source: 'indeed' });
    expect(await finished(run.id)).toMatchObject({ state: 'blocked', listings_found: 0 });
  });

  it("429 Retry-After'a uyar; izin verilenden uzunsa durur", async () => {
    let first = true;
    serve({
      [kn('istanbul')]: () => {
        if (!first) return ok(kariyerPage('İstanbul', 1, [{ id: 4900001, title: 'Grafik Tasarımcı', company: 'Renk' }], false));
        first = false;
        return { status: 429, text: '', headers: { 'retry-after': '5' } };
      },
    });
    const sleeps: number[] = [];
    scraper.sleep = async (ms) => void sleeps.push(ms);
    const [run] = await runNow({ source: 'kariyer_net' });
    expect(await finished(run.id)).toMatchObject({ state: 'succeeded', listings_found: 1 });
    expect(sleeps).toContain(5000);

    serve({ [kn('istanbul')]: { status: 429, text: '', headers: { 'retry-after': '7200' } } });
    const [limited] = await runNow({ source: 'kariyer_net' });
    expect(await finished(limited.id)).toMatchObject({ state: 'rate_limited', errors: [expect.objectContaining({ kind: 'rate_limited', status: 429 })] });
    scraper.sleep = async () => undefined;
  });

  it('sayfa düzeni değişince "selector" hatası ayrı kaydedilir ve yönetici uyarılır', async () => {
    serve({ [kn('istanbul')]: ok(fixture('kariyer-net-changed-layout.html')) });
    const [run] = await runNow({ source: 'kariyer_net' });
    expect(await finished(run.id)).toMatchObject({ state: 'failed', pages_visited: 0, pages_failed: 1, errors: [expect.objectContaining({ kind: 'selector' })] });
    const note = await h.prisma.notification.findFirst({ where: { workspaceId: workspaceOf(admin), type: 'source_blocked' }, orderBy: { createdAt: 'desc' } });
    expect(note?.title).toBe('Kariyer.net taraması: sayfa düzeni değişmiş olabilir');
  });

  it('ağ hatası sınırlı yeniden denemeden sonra o aramayı bitirir, diğer şehir sürer (partial)', async () => {
    await config({ cities: ['İstanbul', 'Ankara'], max_retries: 1 });
    serve({ [kn('istanbul')]: { status: 502, text: 'bad gateway' }, [kn('ankara')]: ok(kariyerPage('Ankara', 1, [{ id: 4950001, title: 'Art Director', company: 'Başkent Ajans' }], false)) });
    const [run] = await runNow({ source: 'kariyer_net' });
    const done = await finished(run.id);
    expect(done).toMatchObject({ state: 'partial', pages_visited: 1, pages_failed: 1, listings_found: 1 });
    expect(done.errors).toEqual([expect.objectContaining({ kind: 'network', city: 'İstanbul', status: 502 })]);
  });
});

describe('eşzamanlılık ve zamanlama', () => {
  it('aynı site için sırada ya da çalışan tarama varken ikincisi açılmaz', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => scraper.enqueue({ source: 'kariyer_net', trigger: 'manual' })));
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.run.id)).size).toBe(1);
    const again = await h.http().post('/api/v1/scrapers/run').set(admin.auth).send({ source: 'kariyer_net' }).expect(202);
    expect(again.body.runs[0]).toMatchObject({ id: results[0].run.id, already_running: true });
    expect(await h.prisma.scraperRun.count()).toBe(1);
    expect(await h.prisma.outboxEvent.count({ where: { eventType: 'scraper.run', aggregateId: results[0].run.id } })).toBe(1);
  });

  it('aynı çalışma iki kez teslim edilse de bir kez yürür', async () => {
    serve({ [kn('istanbul')]: ok(kariyerPage('İstanbul', 1, [{ id: 4960001, title: 'Grafik Tasarımcı', company: 'Renk' }], false)) });
    const { run } = await scraper.enqueue({ source: 'kariyer_net' });
    const [a, b] = await Promise.all([scraper.execute(run.id), scraper.execute(run.id)]);
    expect([a.state, b.state]).toContain('succeeded');
    const done = await h.prisma.scraperRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(done).toMatchObject({ state: 'succeeded', pagesVisited: 1, listingsNew: 1 });
    expect(await h.prisma.scrapedJob.count()).toBe(1);
  });

  it('zamanlayıcı süresi gelen siteyi kuyruğa alır, aralık dolmadan yenisini açmaz; kapalı site zamanlanmaz', async () => {
    await config({ sources: { indeed: { enabled: false } } });
    const now = new Date();
    expect(await scraper.scheduleDue(now)).toEqual({ queued: ['kariyer_net'] });
    expect(await scraper.scheduleDue(now)).toEqual({ queued: [] });
    serve({ [kn('istanbul')]: ok(kariyerPage('İstanbul', 1, [{ id: 4970001, title: 'Grafik Tasarımcı', company: 'Renk' }], false)) });
    await h.worker.drain();
    expect((await runs('kariyer_net')).map((r) => [r.trigger, r.state])).toEqual([['schedule', 'succeeded']]);
    expect(await scraper.scheduleDue(new Date(now.getTime() + 3 * 3600_000))).toEqual({ queued: [] });
    expect(await scraper.scheduleDue(new Date(now.getTime() + 4 * 3600_000 + 60_000))).toEqual({ queued: ['kariyer_net'] });
  });

  it('zaman aşımına uğrayan çalışma kapanır ve site yeniden zamanlanabilir', async () => {
    const stale = await h.prisma.scraperRun.create({ data: { source: 'kariyer_net', state: 'running', cities: ['İstanbul'], startedAt: new Date(Date.now() - 2 * 3600_000), queuedAt: new Date(Date.now() - 2 * 3600_000) } });
    await config({ sources: { indeed: { enabled: false } } });
    expect(await scraper.scheduleDue(new Date())).toEqual({ queued: [] });
    expect((await h.prisma.scraperRun.findUniqueOrThrow({ where: { id: stale.id } })).state).toBe('failed');
    expect(await scraper.scheduleDue(new Date(Date.now() + 2 * 3600_000 + 60_000))).toEqual({ queued: ['kariyer_net'] });
  });

  it('servis doğrudan çağrılabilir ve sonucu döndürür', async () => {
    serve({ [`${INDEED}/jobs?q=Flutter%20Developer&l=Kocaeli&sort=date`]: ok(fixture('indeed-search.html')) });
    const result = await scraper.run({ source: 'indeed', cities: ['Kocaeli'], keywords: ['Flutter Developer'], max_pages: 1 });
    expect(result).toMatchObject({ source: 'indeed', trigger: 'api', state: 'succeeded', already_running: false, listings_found: 4 });
  });
});

describe('API', () => {
  async function seed() {
    serve({
      [kn('istanbul')]: ok(
        kariyerPage(
          'İstanbul',
          1,
          [
            { id: 5000001, title: 'Kreatif Direktör', company: 'Kabuk Ajans' },
            { id: 5000002, title: 'Art Director', company: 'Yosun Reklam', location: 'İstanbul(Asya) - Kadıköy' },
            { id: 5000003, title: 'Muhasebe Uzmanı', company: 'Defter Ltd.' },
          ],
          false,
        ),
      ),
    });
    await runNow({ source: 'kariyer_net' });
  }

  it('ilan listesi süzülür ve imleçle sayfalanır', async () => {
    await seed();
    const get = (q: string) => h.http().get(`/api/v1/scrapers/jobs${q}`).set(member.auth).expect(200).then((r) => r.body);
    expect((await get('?company=yosun')).items.map((j: any) => j.job_title)).toEqual(['Art Director']);
    expect((await get('?title=direkt')).items.map((j: any) => j.company_name)).toEqual(['Kabuk Ajans']);
    expect((await get('?city=kadıköy')).total).toBe(1);
    expect((await get('?source=indeed')).total).toBe(0);
    expect((await get(`?from=${new Date(Date.now() + 60_000).toISOString()}`)).total).toBe(0);
    expect((await get(`?to=${new Date(Date.now() + 60_000).toISOString()}`)).total).toBe(3);
    expect((await get('?only_new=true')).total).toBe(3);
    expect((await get(`/new?since=${new Date(Date.now() + 60_000).toISOString()}`)).total).toBe(0);
    const first = await get('?limit=2');
    expect(first.items).toHaveLength(2);
    expect(first.next_cursor).toBeTruthy();
    const second = await get(`?limit=2&cursor=${first.next_cursor}`);
    expect(second.items).toHaveLength(1);
    expect(second.next_cursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((j: any) => j.id)).size).toBe(3);
    const one = await h.http().get(`/api/v1/scrapers/jobs/${first.items[0].id}`).set(member.auth).expect(200);
    expect(one.body.id).toBe(first.items[0].id);
    await h.http().get('/api/v1/scrapers/jobs/yok').set(member.auth).expect(404);
    await h.http().get('/api/v1/scrapers/jobs?from=dun').set(member.auth).expect(400);
  });

  it('geçmiş ve durum', async () => {
    await seed();
    const history = await h.http().get('/api/v1/scrapers/history?source=kariyer_net').set(member.auth).expect(200);
    expect(history.body.items).toHaveLength(1);
    expect(history.body.items[0]).toMatchObject({ state: 'succeeded', listings_new: 3 });
    const status = await h.http().get('/api/v1/scrapers/status').set(member.auth).expect(200);
    expect(status.body.sources.map((s: any) => s.source)).toEqual(['kariyer_net', 'indeed']);
    expect(status.body.sources[0]).toMatchObject({ health: 'ok', active_jobs: 3, new_jobs_24h: 3, keyword_mode: 'local_filter', interval_hours: 4 });
    expect(status.body.sources[1]).toMatchObject({ health: 'never', max_pages: 1 });
  });

  it('ayar yalnızca yöneticiye açıktır ve doğrulanır', async () => {
    await h.http().post('/api/v1/scrapers/config').set(member.auth).send({ enabled: false }).expect(403);
    await h.http().post('/api/v1/scrapers/run').set(member.auth).send({ source: 'indeed' }).expect(403);
    const bad = await h.http().post('/api/v1/scrapers/config').set(admin.auth).send({ sources: { indeed: { interval_hours: 0 } } }).expect(400);
    expect(bad.body.error.details).toEqual([expect.stringContaining('sources.indeed.interval_hours')]);
    await h.http().post('/api/v1/scrapers/config').set(admin.auth).send({ sources: { kariyer_net: { keyword_mode: 'query' } } }).expect(400);
    const saved = await h.http().put('/api/v1/scrapers/config').set(admin.auth).send({ sources: { indeed: { interval_hours: 6 } }, keywords: ['Flutter Developer'] }).expect(200);
    expect(saved.body).toMatchObject({ sources: { indeed: { interval_hours: 6, max_pages: 1 }, kariyer_net: { interval_hours: 4 } }, keywords: ['Flutter Developer'] });
    const read = await h.http().get('/api/v1/scrapers/config').set(member.auth).expect(200);
    expect(read.body.sources.indeed.interval_hours).toBe(6);
    await h.http().post('/api/v1/scrapers/run').set(admin.auth).send({ source: 'linkedin' }).expect(400);
  });

  it('tarama genel olarak kapalıyken zamanlanmış çalışma istek atmadan atlanır', async () => {
    await config({ enabled: false });
    const calls = serve({});
    const { run } = await scraper.enqueue({ source: 'kariyer_net', trigger: 'schedule' });
    await h.worker.drain();
    expect((await h.prisma.scraperRun.findUniqueOrThrow({ where: { id: run.id } })).state).toBe('skipped');
    expect(calls).toEqual([]);
    expect(await scraper.scheduleDue(new Date())).toEqual({ queued: [] });
  });
});
