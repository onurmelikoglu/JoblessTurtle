import { AiService } from '../../src/engine/ai/ai.service';
import { ScraperService } from '../../src/engine/scraper.service';
import { createHarness, Harness, resetDb, setupUser, User } from './harness';

let h: Harness;
let admin: User;
let member: User;
let scraper: ScraperService;

const KARIYER = 'https://www.kariyer.net';
const KARIYER_PAGE = `${KARIYER}/is-ilanlari/istanbul`;
const INDEED_PAGE = 'https://tr.indeed.com/jobs?q=flutter&l=%C4%B0stanbul&sort=date';
const workspaceOf = (u: User) => u.candidate.workspaceId as string;

type Row = (string | number | null)[];

/** Okuma betiğinin çıktısı (bkz. parsers/*.browser.ts); kartlar kurgusaldır. */
const payload = (source: string, cards: Row[], extra: Record<string, unknown> = {}) => ({ v: 1, source, url: KARIYER_PAGE, marker: null, root: true, next: false, cards, ...extra });
const kariyerCard = (id: number, title: string, company: string, location = 'İstanbul(Avr.)'): Row => [`/is-ilani/ilan-${id}`, title, company, location, 'Tam zamanlı', 'İş Yerinde', 'Bugün', 'Default'];
const PAGE = [kariyerCard(5100001, 'Kreatif Direktör', 'Midye Ajans'), kariyerCard(5100002, 'Muhasebe Uzmanı', 'Defter Ltd.'), kariyerCard(5100003, 'Creative Director', 'Gizli Firma')];

async function keyOf(u: User): Promise<string> {
  const res = await h.http().post('/api/v1/scrapers/extension/key').set(u.auth).expect(201);
  return res.body.key as string;
}

function send(key: string | null, body: Record<string, unknown>) {
  const req = h.http().post('/api/v1/scrapers/import');
  return (key === null ? req : req.set('X-Import-Token', key)).send(body);
}

beforeAll(async () => {
  h = await createHarness();
  await resetDb(h.prisma);
  scraper = h.app.get(ScraperService);
  scraper.fetcher = async (url) => {
    throw new Error(`Eklenti aktarımında siteye istek atılmamalı: ${url}`);
  };
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
  await h.prisma.extensionKey.deleteMany();
  await h.prisma.keyValue.deleteMany({ where: { key: 'scraper:config' } });
  await h.http().post('/api/v1/scrapers/config').set(admin.auth).send({ cities: ['İstanbul'] }).expect(201);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('eklenti anahtarı', () => {
  it('üretilir, yalnızca özeti saklanır, yenisi eskisini geçersiz kılar, iptal edilir', async () => {
    expect((await h.http().get('/api/v1/scrapers/extension/key').set(member.auth).expect(200)).body).toEqual({ exists: false, created_at: null, last_used_at: null });
    const first = await keyOf(member);
    expect(first).toMatch(/^jt_[a-z0-9]+\.[A-Za-z0-9_-]{43}$/);
    const row = await h.prisma.extensionKey.findUniqueOrThrow({ where: { userId: (await h.prisma.user.findUniqueOrThrow({ where: { email: member.email } })).id } });
    expect(JSON.stringify(row)).not.toContain(first.split('.')[1]);

    const check = await h.http().get('/api/v1/scrapers/import/check').set('X-Import-Token', first).expect(200);
    expect(check.body).toEqual({ ok: true, display_name: 'uye' });
    const status = (await h.http().get('/api/v1/scrapers/extension/key').set(member.auth).expect(200)).body;
    expect(status.exists).toBe(true);
    expect(status.last_used_at).not.toBeNull();

    const second = await keyOf(member);
    await h.http().get('/api/v1/scrapers/import/check').set('X-Import-Token', first).expect(401);
    await h.http().get('/api/v1/scrapers/import/check').set('X-Import-Token', second).expect(200);
    await h.http().delete('/api/v1/scrapers/extension/key').set(member.auth).expect(204);
    await h.http().get('/api/v1/scrapers/import/check').set('X-Import-Token', second).expect(401);
    expect((await h.http().get('/api/v1/scrapers/extension/key').set(member.auth).expect(200)).body.exists).toBe(false);
  });

  it('anahtar yönetimi oturum ister', async () => {
    await h.http().post('/api/v1/scrapers/extension/key').expect(401);
    await h.http().get('/api/v1/scrapers/extension/searches').expect(401);
  });
});

describe('sayfa aktarımı: kimlik ve adres', () => {
  it('anahtar yoksa, bozuksa ya da yanlışsa 401; gövde anahtardan önce okunmaz', async () => {
    const key = await keyOf(member);
    const body = { source: 'kariyer_net', url: KARIYER_PAGE, payload: payload('kariyer_net', PAGE) };
    expect((await send(null, body).expect(401)).body.error.code).toBe('IMPORT_KEY_REQUIRED');
    expect((await send('yanlis', body).expect(401)).body.error.code).toBe('IMPORT_KEY_INVALID');
    expect((await send(`${key.slice(0, -2)}xx`, body).expect(401)).body.error.code).toBe('IMPORT_KEY_INVALID');
    expect((await send(null, { bozuk: true }).expect(401)).body.error.code).toBe('IMPORT_KEY_REQUIRED');
    await send(key, { source: 'kariyer_net' }).expect(400);
    expect(await h.prisma.scraperRun.count()).toBe(0);
    expect(await h.prisma.scrapedJob.count()).toBe(0);
  });

  it('adres o sitenin arama sayfası değilse 400 ve hiçbir şey kaydedilmez', async () => {
    const key = await keyOf(member);
    for (const [source, url] of [
      ['kariyer_net', 'https://www.kariyer.net.example.test/is-ilanlari/istanbul'],
      ['kariyer_net', 'https://www.kariyer.net/is-ilani/ilan-5100001'],
      ['kariyer_net', INDEED_PAGE],
      ['indeed', 'https://tr.indeed.com/viewjob?jk=0a1b2c3d4e5f6a7b'],
      ['indeed', 'bir adres değil'],
    ]) {
      const res = await send(key, { source, url, payload: payload(source, PAGE) }).expect(400);
      expect(res.body.error.code).toBe('IMPORT_URL_INVALID');
    }
    expect(await h.prisma.scraperRun.count()).toBe(0);
  });

  it('doğrulama sayfasında çalışma açılmaz, "verification" döner', async () => {
    const key = await keyOf(member);
    const res = await send(key, { source: 'kariyer_net', url: `${KARIYER}/is-ilanlari/istanbul-2`, payload: payload('kariyer_net', [], { marker: 'px-captcha', root: false }) }).expect(200);
    expect(res.body).toEqual({ status: 'verification', message: expect.stringContaining('doğrulama') });
    expect(await h.prisma.scraperRun.count()).toBe(0);
  });

  it('düzeni değişmiş sayfa "failed" çalışması olarak kaydedilir', async () => {
    const key = await keyOf(member);
    const res = await send(key, { source: 'kariyer_net', url: KARIYER_PAGE, payload: payload('kariyer_net', [], { root: false }) }).expect(200);
    expect(res.body).toMatchObject({ status: 'failed', message: expect.stringContaining('selector') });
    const run = await h.prisma.scraperRun.findUniqueOrThrow({ where: { id: res.body.run_id } });
    expect(run).toMatchObject({ trigger: 'extension', state: 'failed', pagesVisited: 0, pagesFailed: 1 });
  });
});

describe('sayfa aktarımı: kayıt, tekilleştirme ve profile aktarım', () => {
  it('kartlar ortak kayda yazılır, profile uyan ilan yalnızca anahtar sahibinin çalışma alanına eklenir ve bildirilir', async () => {
    const key = await keyOf(member);
    const res = await send(key, { source: 'kariyer_net', url: KARIYER_PAGE, payload: payload('kariyer_net', PAGE, { next: true }) }).expect(200);
    expect(res.body).toMatchObject({ status: 'imported', state: 'succeeded', listings_found: 3, listings_new: 3, listings_updated: 0, forwarded: 1, has_next_page: true });

    const run = await h.prisma.scraperRun.findUniqueOrThrow({ where: { id: res.body.run_id } });
    const memberId = (await h.prisma.user.findUniqueOrThrow({ where: { email: member.email } })).id;
    expect(run).toMatchObject({ source: 'kariyer_net', trigger: 'extension', state: 'succeeded', cities: ['İstanbul'], keywords: [], maxPages: 1, pagesVisited: 1, listingsFound: 3, forwarded: 1, requestedById: memberId });
    expect((await h.prisma.scrapedJob.findMany({ orderBy: { externalId: 'asc' } })).map((j) => [j.externalId, j.jobTitle, j.city])).toEqual([
      ['5100001', 'Kreatif Direktör', 'İstanbul'],
      ['5100002', 'Muhasebe Uzmanı', 'İstanbul'],
      ['5100003', 'Creative Director', 'İstanbul'],
    ]);

    const jobsOf = (u: User) => h.prisma.job.findMany({ where: { workspaceId: workspaceOf(u), listings: { some: { source: { kind: 'scrape_kariyer_net' } } } }, include: { company: true } });
    expect((await jobsOf(member)).map((j) => [j.title, j.company.name])).toEqual([['Kreatif Direktör', 'Midye Ajans']]);
    expect(await jobsOf(admin)).toEqual([]);
    await h.worker.drain();
    const note = await h.prisma.notification.findFirst({ where: { workspaceId: workspaceOf(member), type: 'new_jobs' }, orderBy: { createdAt: 'desc' } });
    expect(note?.title).toBe('Kariyer.net (tarayıcı eklentisi): 1 yeni ilan eklendi');
  });

  it('aynı sayfa yeniden aktarılınca yeni kayıt açılmaz; başka kullanıcının aktarımı onun profiline eklenir', async () => {
    const memberKey = await keyOf(member);
    const body = { source: 'kariyer_net', url: KARIYER_PAGE, payload: payload('kariyer_net', PAGE) };
    await send(memberKey, body).expect(200);
    const again = await send(memberKey, body).expect(200);
    expect(again.body).toMatchObject({ status: 'imported', listings_found: 3, listings_new: 0, listings_updated: 0, forwarded: 0 });
    expect(await h.prisma.scrapedJob.count()).toBe(3);
    expect(await h.prisma.job.count({ where: { workspaceId: workspaceOf(member), title: 'Kreatif Direktör', company: { name: 'Midye Ajans' } } })).toBe(1);

    const adminImport = await send(await keyOf(admin), body).expect(200);
    expect(adminImport.body).toMatchObject({ listings_new: 0, forwarded: 1 });
    expect(await h.prisma.job.count({ where: { workspaceId: workspaceOf(admin), title: 'Kreatif Direktör', company: { name: 'Midye Ajans' } } })).toBe(1);
  });

  it('Indeed araması: şehir "l", anahtar kelime "q" parametresinden', async () => {
    const key = await keyOf(member);
    const cards: Row[] = [['0a1b2c3d4e5f6a7b', 'Flutter Developer', 'Kabuk Teknoloji', 'Kadıköy', 'T34', 0, 'Tam zamanlı', null, 'Bugün', null]];
    const res = await send(key, { source: 'indeed', url: INDEED_PAGE, payload: payload('indeed', cards) }).expect(200);
    expect(res.body).toMatchObject({ status: 'imported', listings_new: 1 });
    expect(await h.prisma.scraperRun.findUniqueOrThrow({ where: { id: res.body.run_id } })).toMatchObject({ source: 'indeed', cities: ['İstanbul'], keywords: ['flutter'] });
    expect(await h.prisma.scrapedJob.findFirstOrThrow({ where: { source: 'indeed' } })).toMatchObject({ city: 'İstanbul', district: 'Kadıköy', jobUrl: 'https://tr.indeed.com/viewjob?jk=0a1b2c3d4e5f6a7b' });
  });
});

describe('eklenti çalışmaları zamanlamayı etkilemez', () => {
  it('site kilidine takılmaz, sıradaki tarama zamanını ve sitenin durumunu değiştirmez', async () => {
    await send(await keyOf(member), { source: 'kariyer_net', url: KARIYER_PAGE, payload: payload('kariyer_net', PAGE) }).expect(200);
    await h.prisma.scraperRun.create({ data: { source: 'kariyer_net', trigger: 'extension', state: 'running', startedAt: new Date(), cities: ['İstanbul'] } });

    const status = (await h.http().get('/api/v1/scrapers/status').set(admin.auth).expect(200)).body.sources.find((s: any) => s.source === 'kariyer_net');
    expect(status).toMatchObject({ health: 'never', last_run: null, active_run: null });
    expect(new Date(status.next_run_at).getTime()).toBe(0);

    const scheduled = await scraper.enqueue({ source: 'kariyer_net', trigger: 'manual' });
    expect(scheduled.created).toBe(true);
    const history = (await h.http().get('/api/v1/scrapers/history?source=kariyer_net').set(admin.auth).expect(200)).body.items;
    expect(history.map((r: any) => r.trigger).sort()).toEqual(['extension', 'extension', 'manual']);
  });
});

describe('profilden eklenti aramaları', () => {
  it('Kariyer.net şehir sayfası ve Indeed unvan × şehir, en yeni önce; sonunda #jt-import', async () => {
    const res = await h.http().get('/api/v1/scrapers/extension/searches').set(member.auth).expect(200);
    expect(res.body.searches).toEqual([
      { source: 'kariyer_net', label: 'Kariyer.net', city: 'İstanbul', keyword: null, url: `${KARIYER}/is-ilanlari/istanbul#jt-import` },
      { source: 'indeed', label: 'Indeed', city: 'İstanbul', keyword: 'Kreatif Direktör', url: 'https://tr.indeed.com/jobs?q=Kreatif%20Direkt%C3%B6r&l=%C4%B0stanbul&sort=date#jt-import' },
      { source: 'indeed', label: 'Indeed', city: 'İstanbul', keyword: 'Creative Director', url: 'https://tr.indeed.com/jobs?q=Creative%20Director&l=%C4%B0stanbul&sort=date#jt-import' },
    ]);
  });
});
