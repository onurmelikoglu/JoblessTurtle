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

/** Kısa süreli tekrar koruması süreç belleğindedir; testler arası ve "pencere geçti" senaryosu için boşaltılır. */
const forgetRecentImports = () => (scraper as unknown as { recentImports: Map<string, unknown> }).recentImports.clear();

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
  forgetRecentImports();
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

  it('aynı sayfa hemen yeniden gönderilirse yeni çalışma açılmaz, önceki sonuç döner', async () => {
    const memberKey = await keyOf(member);
    const body = { source: 'kariyer_net', url: KARIYER_PAGE, payload: payload('kariyer_net', PAGE) };
    const first = await send(memberKey, body).expect(200);
    const repeats = await Promise.all([send(memberKey, body), send(memberKey, { ...body, url: `${KARIYER_PAGE}#jt-import` })]);
    for (const r of repeats) expect(r.body).toEqual(first.body);
    expect(await h.prisma.scraperRun.count()).toBe(1);
    const otherPage = await send(memberKey, { ...body, payload: payload('kariyer_net', PAGE.slice(0, 2)) }).expect(200);
    expect(otherPage.body.run_id).not.toBe(first.body.run_id);
  });

  it('aynı sayfa sonra yeniden aktarılınca yeni kayıt açılmaz; başka kullanıcının aktarımı onun profiline eklenir', async () => {
    const memberKey = await keyOf(member);
    const body = { source: 'kariyer_net', url: KARIYER_PAGE, payload: payload('kariyer_net', PAGE) };
    await send(memberKey, body).expect(200);
    forgetRecentImports();
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
  it('her sitede en az sayıda arama (Kariyer.net çok şehirli, Indeed pozisyonlar VEYA ile); sonunda hesabın şifreli etiketi', async () => {
    const res = await h.http().get('/api/v1/scrapers/extension/searches').set(member.auth).expect(200);
    const searches = res.body.searches as { source: string; label: string; cities: string[]; keywords: string[]; url: string }[];
    const tags = new Set(searches.map((s) => s.url.split('#')[1]));
    expect(tags.size).toBe(1);
    const [tag] = [...tags];
    expect(tag).toMatch(/^jt-import=[A-Za-z0-9_-]+$/);
    expect(tag).not.toContain(workspaceOf(member));
    expect(searches.map((s) => [s.source, s.cities, s.keywords, s.url.split('#')[0]])).toEqual([
      ['kariyer_net', ['İstanbul'], ['Kreatif Direktör'], `${KARIYER}/is-ilanlari?ct=34,82&kw=Kreatif%20Direkt%C3%B6r`],
      ['kariyer_net', ['İstanbul'], ['Creative Director'], `${KARIYER}/is-ilanlari?ct=34,82&kw=Creative%20Director`],
      ['indeed', ['İstanbul'], ['Kreatif Direktör', 'Creative Director'], 'https://tr.indeed.com/jobs?q=%22Kreatif%20Direkt%C3%B6r%22%20or%20%22Creative%20Director%22&l=%C4%B0stanbul&sort=date'],
      ['eleman_net', [], ['Kreatif Direktör'], 'https://www.eleman.net/is-ilanlari?aranan=Kreatif+Direkt%C3%B6r'],
      ['eleman_net', [], ['Creative Director'], 'https://www.eleman.net/is-ilanlari?aranan=Creative+Director'],
      ['isinolsun', ['İstanbul'], ['Kreatif Direktör'], 'https://isinolsun.com/is-ilanlari?kw=Kreatif+Direkt%C3%B6r&lc=%C4%B0stanbul'],
      ['isinolsun', ['İstanbul'], ['Creative Director'], 'https://isinolsun.com/is-ilanlari?kw=Creative+Director&lc=%C4%B0stanbul'],
      ['secretcv', [], ['Kreatif Direktör'], 'https://www.secretcv.com/is-ilanlari/ara-is-ilanlari?k=Kreatif%20Direkt%C3%B6r'],
      ['secretcv', [], ['Creative Director'], 'https://www.secretcv.com/is-ilanlari/ara-is-ilanlari?k=Creative%20Director'],
      ['yenibiris', ['İstanbul'], ['Kreatif Direktör'], 'https://www.yenibiris.com/is-ilanlari/istanbul?q=Kreatif+Direkt%C3%B6r'],
      ['yenibiris', ['İstanbul'], ['Creative Director'], 'https://www.yenibiris.com/is-ilanlari/istanbul?q=Creative+Director'],
    ]);
  });
});

describe('aramayı başlatan hesaba aktarım', () => {
  const tagOf = async (u: User) => {
    const res = await h.http().get('/api/v1/scrapers/extension/searches').set(u.auth).expect(200);
    return (res.body.searches[0].url as string).split('#jt-import=')[1];
  };
  const page = (id: number) => payload('kariyer_net', [kariyerCard(id, 'Kreatif Direktör', `Hedef Ajans ${id}`)]);
  const jobsIn = (u: User, id: number) => h.prisma.job.count({ where: { workspaceId: workspaceOf(u), company: { name: `Hedef Ajans ${id}` } } });

  it('A\'nın anahtarıyla B\'nin etiketli aramasından gelen sayfa yalnız B\'ye; etiketsiz sayfa A\'ya gider; geçersiz etiket 400', async () => {
    const key = await keyOf(admin);
    const forMember = await send(key, { source: 'kariyer_net', url: `${KARIYER}/is-ilanlari?ct=34,82&kw=kreatif`, payload: page(5300001), target: await tagOf(member) }).expect(200);
    expect(forMember.body).toMatchObject({ status: 'imported', forwarded: 1 });
    expect([await jobsIn(member, 5300001), await jobsIn(admin, 5300001)]).toEqual([1, 0]);
    const run = await h.prisma.scraperRun.findUniqueOrThrow({ where: { id: forMember.body.run_id } });
    expect(run).toMatchObject({ targetWorkspaceId: workspaceOf(member), cities: ['İstanbul'], keywords: ['kreatif'] });
    expect(run.requestedById).toBe((await h.prisma.user.findUniqueOrThrow({ where: { email: admin.email } })).id);

    await send(key, { source: 'kariyer_net', url: KARIYER_PAGE, payload: page(5300002) }).expect(200);
    expect([await jobsIn(member, 5300002), await jobsIn(admin, 5300002)]).toEqual([0, 1]);

    for (const target of ['bozuk', `${(await tagOf(member)).slice(0, 20)}x${(await tagOf(member)).slice(21)}`]) {
      const res = await send(key, { source: 'kariyer_net', url: KARIYER_PAGE, payload: page(5300003), target }).expect(400);
      expect(res.body.error.code).toBe('IMPORT_TARGET_INVALID');
    }
    expect(await h.prisma.scrapedJob.count({ where: { externalId: '5300003' } })).toBe(0);
  });

  it('aynı sayfa yeniden aktarılınca hedefte kayıt ve bildirim çoğalmaz; ortak kayıtta görülmüş ilan da hedefe eklenir', async () => {
    const key = await keyOf(admin);
    await send(key, { source: 'kariyer_net', url: KARIYER_PAGE, payload: page(5300011) }).expect(200);
    const tag = await tagOf(member);
    const first = await send(key, { source: 'kariyer_net', url: `${KARIYER}/is-ilanlari/istanbul-2`, payload: page(5300011), target: tag }).expect(200);
    expect(first.body).toMatchObject({ listings_new: 0, forwarded: 1 });
    await h.worker.drain();
    const notes = () => h.prisma.notification.count({ where: { workspaceId: workspaceOf(member), type: 'new_jobs' } });
    const before = await notes();
    const again = await send(key, { source: 'kariyer_net', url: `${KARIYER}/is-ilanlari/istanbul-3`, payload: page(5300011), target: tag }).expect(200);
    expect(again.body).toMatchObject({ forwarded: 0 });
    await h.worker.drain();
    expect(await notes()).toBe(before);
    expect(await jobsIn(member, 5300011)).toBe(1);
  });
});

describe('yeni siteler', () => {
  it('Yenibiriş (yalnızca eklenti) sayfası aktarılır, profile uyan ilan eklenir; sunucuya istek atılmaz', async () => {
    const key = await keyOf(member);
    const cards: Row[] = [
      ['https://www.yenibiris.com/is-ilani/kreatif-direktor/1300101', 'Kreatif Direktör', 'Midye Ajans', 'İstanbul Anadolu Yakası - Kadıköy', 'Bugün', 'Tam zamanlı|Hibrit'],
      ['https://www.yenibiris.com/is-ilani/muhasebe-uzmani/1300102', 'Muhasebe Uzmanı', 'Defter Ltd.', 'İstanbul Avrupa Yakası', 'Son 1 Hafta', 'Tam zamanlı|İş Yerinde'],
    ];
    const res = await send(key, { source: 'yenibiris', url: 'https://www.yenibiris.com/is-ilanlari/istanbul?q=kreatif', payload: payload('yenibiris', cards) }).expect(200);
    expect(res.body).toMatchObject({ status: 'imported', listings_found: 2, listings_new: 2, forwarded: 1 });
    expect(await h.prisma.scraperRun.findUniqueOrThrow({ where: { id: res.body.run_id } })).toMatchObject({ source: 'yenibiris', trigger: 'extension', cities: ['İstanbul'], keywords: ['kreatif'] });
    expect(await h.prisma.scrapedJob.findFirstOrThrow({ where: { source: 'yenibiris', externalId: '1300101' } })).toMatchObject({ city: 'İstanbul', district: 'Kadıköy', workMode: 'hybrid' });
    expect(await h.prisma.job.count({ where: { workspaceId: workspaceOf(member), listings: { some: { source: { kind: 'scrape_yenibiris' } } } } })).toBe(1);
  });

  it('Eleman.net, İşin Olsun ve Secretcv sayfaları kendi adreslerinden aktarılır; başka sitenin adresi reddedilir', async () => {
    const key = await keyOf(member);
    const eleman = await send(key, { source: 'eleman_net', url: 'https://www.eleman.net/is-ilanlari/istanbul?sy=2', payload: payload('eleman_net', [['https://www.eleman.net/is-ilani/kreatif-direktor-i4900201', 'Kreatif Direktör', 'Kabuk Ajans', 'İstanbul Avrupa - Şişli', null]]) }).expect(200);
    expect(eleman.body).toMatchObject({ status: 'imported', listings_new: 1 });
    const isinolsun = await send(key, { source: 'isinolsun', url: 'https://isinolsun.com/is-ilanlari?kw=kreatif&lc=%C4%B0stanbul', payload: payload('isinolsun', [['https://isinolsun.com/is-ilani/grafik-tasarimci-yosun-0ioj99998888777766665555444433332222', 'Grafik Tasarımcı', 'Yosun Reklam', 'Moda Mah., Kadıköy, İstanbul', 'Tam Zamanlı']]) }).expect(200);
    expect(isinolsun.body).toMatchObject({ status: 'imported', listings_new: 1 });
    const secretcv = await send(key, { source: 'secretcv', url: 'https://www.secretcv.com/is-ilanlari/ara-is-ilanlari?k=kreatif', payload: payload('secretcv', [['https://www.secretcv.com/kabuk/art-director-is-ilanlari-1890201', 'Art Director', 'Kabuk Stüdyo', 'İstanbul Avrupa', 'İlan Tarihi: Bugün']]) }).expect(200);
    expect(secretcv.body).toMatchObject({ status: 'imported', listings_new: 1 });
    expect(await h.prisma.scrapedJob.findFirstOrThrow({ where: { source: 'isinolsun' } })).toMatchObject({ externalId: '99998888777766665555444433332222', city: 'İstanbul', district: 'Kadıköy' });
    await send(key, { source: 'secretcv', url: 'https://www.eleman.net/is-ilanlari/istanbul', payload: payload('secretcv', []) }).expect(400);
  });
});
