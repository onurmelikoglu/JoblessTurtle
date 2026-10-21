import { readFileSync } from 'fs';
import { join } from 'path';
import { provinceByPlate } from '../../src/domain/provinces';
import { parseRobots, robotsPathAllowed } from '../../src/domain/robots';
import {
  canonicalJobUrl,
  cityKeysOf,
  contentHashOf,
  externalIdOf,
  isConfidentialCompany,
  isRejection,
  listingInCities,
  matchesKeywords,
  normalizeCard,
  relativeDate,
  ScrapedListing,
  similarityKeyOf,
  splitLocation,
} from '../../src/domain/scraped-jobs';
import { applyScraperConfigPatch, DEFAULT_SCRAPER_CONFIG, resolveScraperConfig, sourceTargets } from '../../src/domain/scraper-config';
import { ScraperHttpClient, parseRetryAfter } from '../../src/engine/scrapers/http-client';
import { IndeedScraper } from '../../src/engine/scrapers/indeed.scraper';
import { KariyerNetScraper } from '../../src/engine/scrapers/kariyer-net.scraper';
import { extractJsonObject, indeedLocation, parseIndeedPage } from '../../src/engine/scrapers/parsers/indeed.parser';
import { kariyerCitySlug, parseKariyerNetPage, stripCompanyPrefix } from '../../src/engine/scrapers/parsers/kariyer-net.parser';
import { RateLimiter, runPool } from '../../src/engine/scrapers/rate-limiter';
import { PageContext, PageFetcher, ScrapeError } from '../../src/engine/scrapers/types';

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', 'scrapers', name), 'utf8');
const NOW = new Date('2026-10-20T09:00:00Z');
const kariyer = new KariyerNetScraper();
const indeed = new IndeedScraper();
const ctx = (city = 'İstanbul', page = 1): PageContext => ({ url: `https://example.test/${page}`, target: { city, keyword: null }, page });

describe('Kariyer.net ayrıştırıcısı (kayıtlı sayfa)', () => {
  const page = parseKariyerNetPage(fixture('kariyer-net-istanbul.html'), { citySlug: 'istanbul', page: 1 });

  it('kartları data-test özniteliklerinden okur ve sonraki sayfayı bulur', () => {
    expect(page.cards).toHaveLength(6);
    expect(page.hasNextPage).toBe(true);
    expect(page.cards[1]).toMatchObject({
      platformId: '4500102',
      title: 'Flutter Developer',
      company: 'Kaplumbağa Yazılım A.Ş.',
      location: 'İstanbul(Asya) - Kadıköy',
      url: '/is-ilani/kaplumbaga-yazilim-a-s-flutter-developer-4500102',
      employmentType: 'Tam zamanlı',
      workModeText: 'Hibrit',
      publishedText: 'Bugün',
      dateIsUpdate: false,
    });
  });

  it('sponsorlu kartın "Firma-Pozisyon" başlığından firma adını ayırır; güncelleme tarihini yayın tarihi saymaz', () => {
    expect(page.cards[0]).toMatchObject({ title: 'Gayrimenkul Danışmanı', company: 'Örnek Emlak Grubu', dateIsUpdate: true, publishedText: '2 gün' });
  });

  it('firmasız kartı boş firma ile döndürür (normalizasyonda atılır, uydurulmaz)', () => {
    expect(page.cards[4].company).toBeNull();
    expect(normalizeCard('kariyer_net', page.cards[4], { origin: 'https://www.kariyer.net', searchedCity: 'İstanbul', now: NOW })).toBe('missing_company');
  });

  it('son sayfada sonraki sayfa yoktur', () => {
    const last = parseKariyerNetPage(fixture('kariyer-net-istanbul-3.html'), { citySlug: 'istanbul', page: 3 });
    expect(last.cards).toHaveLength(1);
    expect(last.hasNextPage).toBe(false);
  });

  it('ilan yapısı olmayan sayfada selector hatası verir', () => {
    expect(() => parseKariyerNetPage(fixture('kariyer-net-changed-layout.html'), { citySlug: 'istanbul', page: 1 })).toThrow(expect.objectContaining({ kind: 'selector' }));
  });

  it('şehir adresi ve sayfalama eki', () => {
    expect(kariyerCitySlug('İzmir')).toBe('izmir');
    expect(kariyerCitySlug('Kahramanmaraş')).toBe('kahramanmaras');
    expect(kariyer.searchUrl({ city: 'İstanbul', keyword: 'flutter' }, 1)).toBe('https://www.kariyer.net/is-ilanlari/istanbul');
    expect(kariyer.searchUrl({ city: 'İstanbul', keyword: null }, 2)).toBe('https://www.kariyer.net/is-ilanlari/istanbul-2');
  });

  it('başlıkta firma öneki yoksa başlığa dokunmaz', () => {
    expect(stripCompanyPrefix('Flutter Developer', 'Kaplumbağa')).toBe('Flutter Developer');
    expect(stripCompanyPrefix('Kaplumbağa - Flutter Developer', 'Kaplumbağa')).toBe('Flutter Developer');
    expect(stripCompanyPrefix('Kaplumbağalar Derneği Sekreteri', 'Kaplumbağa')).toBe('Kaplumbağalar Derneği Sekreteri');
  });
});

describe('Indeed ayrıştırıcısı (kayıtlı sayfa)', () => {
  it('gömülü JSON varsa ilanları oradan okur; konum il plakasıyla ilçeye bağlanır', () => {
    const page = parseIndeedPage(fixture('indeed-search.html'));
    expect(page.cards).toHaveLength(4);
    expect(page.hasNextPage).toBe(false);
    expect(page.cards[0]).toMatchObject({ platformId: 'a1b2c3d4e5f60001', title: 'Mobile Developer (CR-01)', company: 'Kaplumbağa Yazılım', location: 'İstanbul - Kağıthane', url: '/viewjob?jk=a1b2c3d4e5f60001', companyUrl: '/cmp/Kaplumbaga-Yazilim' });
    expect(page.cards[0].description).toContain('Mobil ekibimize katılacak');
    expect(page.cards[1]).toMatchObject({ title: 'Flutter Developer "Junior"', employmentType: 'Tam zamanlı, Yeni mezun', location: 'İstanbul' });
    expect(page.cards[1].publishedAt?.getTime()).toBe(1792400000000);
    expect(page.cards[2]).toMatchObject({ workModeText: 'Uzaktan', location: 'Uzaktan' });
    expect(page.cards[3].location).toBe('Kocaeli - Gebze');
  });

  it('gömülü veri yoksa kartlara düşer', () => {
    const page = parseIndeedPage(fixture('indeed-dom-only.html'));
    expect(page.cards.map((c) => [c.platformId, c.title, c.company, c.location])).toEqual([
      ['a1b2c3d4e5f60001', 'Mobile Developer (CR-01)', 'Kaplumbağa Yazılım', 'Kağıthane'],
      ['a1b2c3d4e5f60002', 'Flutter Developer "Junior"', 'Deniz Teknoloji', 'İstanbul'],
    ]);
  });

  it('JSON ayıklayıcı dizgi içindeki parantezlere takılmaz', () => {
    const src = 'x={"a":"}{","b":{"c":[1,{"d":"\\"}"}]}};rest';
    expect(JSON.parse(extractJsonObject(src, 0)!)).toEqual({ a: '}{', b: { c: [1, { d: '"}' }] } });
  });

  it('il plakası ve konum', () => {
    expect(provinceByPlate(34)).toBe('İstanbul');
    expect(provinceByPlate(41)).toBe('Kocaeli');
    expect(provinceByPlate(81)).toBe('Düzce');
    expect(provinceByPlate(82)).toBeNull();
    expect(indeedLocation({ formattedLocation: 'İstanbul', jobLocationState: 'T34' })).toBe('İstanbul');
    expect(indeedLocation({ formattedLocation: 'Uzaktan', jobLocationState: '' })).toBe('Uzaktan');
  });

  it('arama adresi robots.txt sayfalama kuralına uyar ("&start=N&")', () => {
    expect(indeed.searchUrl({ city: 'İstanbul', keyword: 'Flutter Developer' }, 1)).toBe('https://tr.indeed.com/jobs?q=Flutter%20Developer&l=%C4%B0stanbul&sort=date');
    expect(indeed.searchUrl({ city: 'Ankara', keyword: null }, 3)).toBe('https://tr.indeed.com/jobs?q=&l=Ankara&start=20&sort=date');
  });
});

describe('engel algılama', () => {
  const ok = (html: string) => ({ status: 200, url: 'https://example.test', html });

  it('PerimeterX ve Cloudflare doğrulama sayfaları "blocked" sayılır', () => {
    expect(() => kariyer.parsePage(ok(fixture('kariyer-net-blocked.html')), ctx())).toThrow(expect.objectContaining({ kind: 'blocked' }));
    expect(() => indeed.parsePage(ok(fixture('indeed-blocked.html')), ctx())).toThrow(expect.objectContaining({ kind: 'blocked' }));
  });

  it('normal sayfada geçen "captcha" ya da Cloudflare betiği yanlış alarm vermez', () => {
    expect(kariyer.parsePage(ok(fixture('kariyer-net-istanbul.html')), ctx()).cards).toHaveLength(6);
    expect(indeed.parsePage(ok(fixture('indeed-search.html')), ctx()).cards).toHaveLength(4);
  });

  it('düzeni değişmiş sayfa "selector" hatasıdır', () => {
    expect(() => kariyer.parsePage(ok(fixture('kariyer-net-changed-layout.html')), ctx())).toThrow(expect.objectContaining({ kind: 'selector' }));
  });
});

describe('robots.txt', () => {
  const INDEED_ROBOTS = `User-agent: *\nAllow: /\nAllow: /*&start=0&\nAllow: /*&start=10&\nAllow: /*&start=90&\nDisallow: /*&start=\nDisallow: /viewjob\nDisallow: /jobs/TR/\n\nUser-agent: Googlebot\nAllow: /\n`;
  const rules = parseRobots(INDEED_ROBOTS, 'JoblessTurtle/1.1 (+kisisel)');

  it('joker, en uzun eşleşme ve izin önceliği', () => {
    expect(robotsPathAllowed(rules, '/jobs?q=flutter&l=Ankara&sort=date')).toBe(true);
    expect(robotsPathAllowed(rules, '/jobs?q=flutter&l=Ankara&start=10&sort=date')).toBe(true);
    expect(robotsPathAllowed(rules, '/jobs?q=flutter&l=Ankara&sort=date&start=10')).toBe(false);
    expect(robotsPathAllowed(rules, '/jobs?q=x&start=100&sort=date')).toBe(false);
    expect(robotsPathAllowed(rules, '/viewjob?jk=abc')).toBe(false);
    expect(robotsPathAllowed(rules, '/jobs/TR/x')).toBe(false);
  });

  it('ajana özel grup varsa yalnızca o grup uygulanır', () => {
    const own = parseRobots('User-agent: *\nDisallow: /\n\nUser-agent: joblessturtle\nDisallow: /private\n', 'JoblessTurtle/1.1');
    expect(robotsPathAllowed(own, '/is-ilanlari/istanbul')).toBe(true);
    expect(robotsPathAllowed(own, '/private/x')).toBe(false);
  });

  it('Kariyer.net kuralları şehir sayfalarına izin verir, filtre sayfasını yasaklar', () => {
    const kn = parseRobots('User-agent: *\nDisallow: /filtre\nDisallow: /filtre/*\nDisallow: *?ckw*\nDisallow: /*?v=\n', 'JoblessTurtle/1.1');
    expect(robotsPathAllowed(kn, '/is-ilanlari/istanbul-2')).toBe(true);
    expect(robotsPathAllowed(kn, '/filtre/abc')).toBe(false);
    expect(robotsPathAllowed(kn, '/is-ilanlari?ckw=flutter')).toBe(false);
    expect(robotsPathAllowed(kn, '/is-ilanlari/istanbul$')).toBe(true);
  });

  it('sondaki $ bağı', () => {
    const r = parseRobots('User-agent: *\nDisallow: /*.pdf$\n', 'x');
    expect(robotsPathAllowed(r, '/a/b.pdf')).toBe(false);
    expect(robotsPathAllowed(r, '/a/b.pdf?x=1')).toBe(true);
  });
});

describe('tarama HTTP istemcisi', () => {
  const ROBOTS_OK = 'User-agent: *\nDisallow: /yasak\n';
  type Reply = { status: number; text?: string; headers?: Record<string, string>; url?: string } | Error;

  function client(replies: Reply[], opts: Partial<{ maxRetries: number; maxRetryAfterSeconds: number; robots: Reply }> = {}) {
    const calls: string[] = [];
    const sleeps: number[] = [];
    const fetcher: PageFetcher = async (url) => {
      calls.push(url);
      const reply = url.endsWith('/robots.txt') ? (opts.robots ?? { status: 200, text: ROBOTS_OK }) : replies.shift();
      if (!reply) throw new Error('beklenmeyen istek');
      if (reply instanceof Error) throw reply;
      return { status: reply.status, url: reply.url ?? url, headers: reply.headers ?? {}, text: reply.text ?? '<html></html>' };
    };
    const sleep = async (ms: number) => {
      sleeps.push(ms);
    };
    const c = new ScraperHttpClient({ userAgent: 'JoblessTurtle/1.1', maxRetries: opts.maxRetries ?? 2, retryBaseMs: 1000, maxRetryAfterSeconds: opts.maxRetryAfterSeconds ?? 60, limiter: new RateLimiter(0, sleep), blockMarkers: ['px-captcha'], fetcher, sleep, random: () => 0 });
    return { c, calls, sleeps };
  }

  it('geçici hatada üstel beklemeyle sınırlı sayıda yeniden dener', async () => {
    const { c, calls, sleeps } = client([new Error('ECONNRESET'), { status: 502 }, { status: 200, text: '<ok>' }]);
    await expect(c.get('https://site.test/a')).resolves.toMatchObject({ status: 200, html: '<ok>' });
    expect(calls.filter((u) => u.endsWith('/a'))).toHaveLength(3);
    expect(sleeps).toEqual([1000, 2000]);
  });

  it('yeniden deneme hakkı bitince ağ hatası verir', async () => {
    const { c } = client([{ status: 503 }, { status: 503 }, { status: 503 }]);
    await expect(c.get('https://site.test/a')).rejects.toMatchObject({ kind: 'network' });
  });

  it("429'da Retry-After kadar bekler; süre sınırı aşarsa durur", async () => {
    const a = client([{ status: 429, headers: { 'retry-after': '7' } }, { status: 200 }]);
    await expect(a.c.get('https://site.test/a')).resolves.toMatchObject({ status: 200 });
    expect(a.sleeps).toEqual([7000]);
    const b = client([{ status: 429, headers: { 'retry-after': '3600' } }]);
    await expect(b.c.get('https://site.test/a')).rejects.toMatchObject({ kind: 'rate_limited', detail: expect.objectContaining({ retryAfterSeconds: 3600 }) });
  });

  it('403 ve 5xx doğrulama sayfası yeniden denenmeden "blocked" olur', async () => {
    const a = client([{ status: 403, text: '<div id="px-captcha">' }]);
    await expect(a.c.get('https://site.test/a')).rejects.toMatchObject({ kind: 'blocked', message: expect.stringContaining('px-captcha') });
    expect(a.calls).toHaveLength(2);
    const b = client([{ status: 503, text: 'px-captcha' }]);
    await expect(b.c.get('https://site.test/a')).rejects.toMatchObject({ kind: 'blocked' });
  });

  it('giriş sayfasına yönlendirme "login_required" olur', async () => {
    const { c } = client([{ status: 200, url: 'https://secure.site.test/auth?continue=x' }]);
    await expect(c.get('https://site.test/a')).rejects.toMatchObject({ kind: 'login_required' });
  });

  it('robots.txt yasaklıyorsa istek atmaz; robots.txt 5xx ise siteyi taramaz, 404 ise kısıt yok sayar', async () => {
    const a = client([]);
    await expect(a.c.get('https://site.test/yasak/1')).rejects.toMatchObject({ kind: 'robots' });
    expect(a.calls).toEqual(['https://site.test/robots.txt']);
    const b = client([], { robots: { status: 500 } });
    await expect(b.c.get('https://site.test/a')).rejects.toMatchObject({ kind: 'robots' });
    const c = client([{ status: 200 }], { robots: { status: 404 } });
    await expect(c.c.get('https://site.test/yasak/1')).resolves.toMatchObject({ status: 200 });
  });

  it('Retry-After saniye ya da tarih olabilir', () => {
    expect(parseRetryAfter('120')).toBe(120);
    expect(parseRetryAfter(new Date(Date.now() + 30_000).toUTCString())).toBeGreaterThanOrEqual(29);
    expect(parseRetryAfter('yarın')).toBeNull();
    expect(parseRetryAfter(undefined)).toBeNull();
  });
});

describe('hız sınırlayıcı ve eşzamanlılık', () => {
  it('istek başlangıçları arasında en az aralık + rastgele pay bırakır', async () => {
    let clock = 0;
    const waits: number[] = [];
    const limiter = new RateLimiter(
      1000,
      async (ms) => {
        waits.push(ms);
        clock += ms;
      },
      () => clock,
      () => 1,
    );
    await limiter.wait();
    await limiter.wait();
    await limiter.wait();
    expect(waits).toEqual([1250, 1250]);
  });

  it('havuz eşzamanlılık sınırını aşmaz ve durdurulunca yeni iş başlatmaz', async () => {
    let running = 0;
    let peak = 0;
    const done: number[] = [];
    await runPool([1, 2, 3, 4, 5], 2, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      done.push(n);
      running--;
    });
    expect(peak).toBe(2);
    expect(done.sort()).toEqual([1, 2, 3, 4, 5]);
    const started: number[] = [];
    await runPool([1, 2, 3], 1, async (n) => void started.push(n), () => started.length >= 1);
    expect(started).toEqual([1]);
  });
});

describe('normalizasyon ve tekilleştirme kuralları', () => {
  const base = { origin: 'https://www.kariyer.net', searchedCity: 'İstanbul', now: NOW };

  it('konum şehir ve ilçeye ayrılır', () => {
    expect(splitLocation('İstanbul(Avr.)', 'İstanbul')).toEqual({ city: 'İstanbul', district: null });
    expect(splitLocation('İstanbul(Tümü)', 'İstanbul')).toEqual({ city: 'İstanbul', district: null });
    expect(splitLocation('İzmir +81 il daha', 'İzmir')).toEqual({ city: 'İzmir', district: null });
    expect(splitLocation('Ankara +2', 'İzmir')).toEqual({ city: 'Ankara', district: null });
    expect(splitLocation('İstanbul(Asya) - Kadıköy', 'İstanbul')).toEqual({ city: 'İstanbul', district: 'Kadıköy' });
    expect(splitLocation('Kağıthane', 'Ankara')).toEqual({ city: 'İstanbul', district: 'Kağıthane' });
    expect(splitLocation('Kocaeli - Gebze', 'Kocaeli')).toEqual({ city: 'Kocaeli', district: 'Gebze' });
    expect(splitLocation('Uzaktan', 'İstanbul')).toEqual({ city: 'Uzaktan', district: null });
    expect(splitLocation('', 'İstanbul')).toEqual({ city: null, district: null });
  });

  it('kart standart modele çevrilir; ilan adresi sadeleşir, kimlik platform numarasıdır', () => {
    const page = parseKariyerNetPage(fixture('kariyer-net-istanbul.html'), { citySlug: 'istanbul', page: 1 });
    const listing = normalizeCard('kariyer_net', page.cards[2], base) as ScrapedListing;
    expect(listing).toMatchObject({ externalId: '4500103', companyName: 'Defter Mali Müşavirlik', jobTitle: 'Muhasebe Uzmanı', city: 'İstanbul', district: null, jobUrl: 'https://www.kariyer.net/is-ilani/defter-mali-musavirlik-muhasebe-uzmani-4500103', workMode: 'onsite', publishedText: '5 gün' });
    expect(listing.publishedAt?.toISOString()).toBe('2026-10-15T00:00:00.000Z');
    const remote = normalizeCard('kariyer_net', page.cards[3], base) as ScrapedListing;
    expect(remote).toMatchObject({ workMode: 'remote', publishedAt: null, publishedText: '30+ gün' });
    const updated = normalizeCard('kariyer_net', page.cards[0], base) as ScrapedListing;
    expect(updated).toMatchObject({ publishedAt: null, publishedText: 'güncellendi: 2 gün' });
  });

  it('zorunlu alan eksikse ilan uydurulmaz', () => {
    expect(normalizeCard('indeed', { platformId: 'x', title: ' ', company: 'A', location: 'İstanbul', url: '/viewjob?jk=x' }, base)).toBe('missing_title');
    expect(normalizeCard('indeed', { platformId: 'x', title: 'T', company: 'A', location: null, url: '/viewjob?jk=x' }, base)).toBe('missing_city');
    expect(normalizeCard('indeed', { platformId: 'x', title: 'T', company: 'A', location: 'İstanbul', url: null }, base)).toBe('missing_url');
    expect(isRejection('missing_url')).toBe(true);
  });

  it('platform numarası yoksa kimlik sadeleştirilmiş adresin deterministik özetidir', () => {
    const a = canonicalJobUrl('/is-ilani/x-y?utm_source=a#frag', 'https://www.kariyer.net')!;
    const b = canonicalJobUrl('http://www.kariyer.net/is-ilani/x-y?utm_medium=b', 'https://www.kariyer.net')!;
    expect(a).toBe('https://www.kariyer.net/is-ilani/x-y');
    expect(externalIdOf(null, a)).toBe(externalIdOf(null, b));
    expect(externalIdOf(null, a)).toMatch(/^u-[0-9a-f]{24}$/);
    expect(externalIdOf('123', a)).toBe('123');
  });

  it('adı gizli firma tanınır', () => {
    expect(isConfidentialCompany('Gizli Firma')).toBe(true);
    expect(isConfidentialCompany('GİZLİ ŞİRKET')).toBe(true);
    expect(isConfidentialCompany('Confidential')).toBe(true);
    expect(isConfidentialCompany('Gizlice Yazılım')).toBe(false);
  });

  it('benzerlik anahtarı firma ekleri ve Türkçe harflerden bağımsızdır', () => {
    expect(similarityKeyOf('Kaplumbağa Yazılım A.Ş.', 'Flutter Developer')).toBe(similarityKeyOf('KAPLUMBAĞA YAZILIM', 'flutter  developer'));
    expect(similarityKeyOf('Kaplumbağa Yazılım', 'Flutter Developer')).not.toBe(similarityKeyOf('Kaplumbağa Yazılım', 'iOS Developer'));
  });

  it('içerik özeti göreli tarih metninden etkilenmez, içerik değişince değişir', () => {
    const l = { companyName: 'A', jobTitle: 'B', city: 'İstanbul', district: null, employmentType: null, workMode: null, description: null, companyUrl: null, jobUrl: 'https://x/1' } as const;
    expect(contentHashOf(l)).toBe(contentHashOf({ ...l }));
    expect(contentHashOf(l)).not.toBe(contentHashOf({ ...l, jobTitle: 'B2' }));
  });

  it('göreli tarih', () => {
    expect(relativeDate('Bugün', NOW)?.toISOString()).toBe('2026-10-20T00:00:00.000Z');
    expect(relativeDate('Dün', NOW)?.toISOString()).toBe('2026-10-19T00:00:00.000Z');
    expect(relativeDate('3 saat önce', NOW)?.toISOString()).toBe('2026-10-20T00:00:00.000Z');
    expect(relativeDate('2 hafta önce', NOW)?.toISOString()).toBe('2026-10-06T00:00:00.000Z');
    expect(relativeDate('30+ gün önce', NOW)).toBeNull();
    expect(relativeDate('Az önce yayınlandı', NOW)?.toISOString()).toBe('2026-10-20T00:00:00.000Z');
  });

  it('anahtar kelime ve şehir süzgeci', () => {
    const l = { jobTitle: 'Senior Flutter Developer', companyName: 'Kaplumbağa', city: 'İstanbul', workMode: null } as const;
    expect(matchesKeywords(l, [])).toBe(true);
    expect(matchesKeywords(l, ['flutter'])).toBe(true);
    expect(matchesKeywords(l, ['iOS', 'Kotlin'])).toBe(false);
    expect(matchesKeywords(l, ['lutter'])).toBe(false);
    const keys = cityKeysOf('İstanbul; İstanbul (Anadolu Yakası); Kocaeli');
    expect([...keys]).toEqual(['istanbul', 'kocaeli']);
    expect(listingInCities(l, keys)).toBe(true);
    expect(listingInCities({ city: 'Ankara', workMode: null }, keys)).toBe(false);
    expect(listingInCities({ city: 'Uzaktan', workMode: 'remote' }, keys)).toBe(true);
    expect(listingInCities({ city: 'Ankara', workMode: null }, new Set())).toBe(true);
  });
});

describe('tarama ayarı', () => {
  it('kayıtlı eksik ayar varsayılanlarla tamamlanır; geçersiz kayıt varsayılana döner', () => {
    expect(resolveScraperConfig(null)).toEqual(DEFAULT_SCRAPER_CONFIG);
    const c = resolveScraperConfig({ sources: { indeed: { interval_hours: 6 } }, cities: ['Bursa'] });
    expect(c.sources.indeed.interval_hours).toBe(6);
    expect(c.sources.indeed.max_pages).toBe(1);
    expect(c.sources.kariyer_net.interval_hours).toBe(4);
    expect(c.cities).toEqual(['Bursa']);
    expect(resolveScraperConfig({ max_retries: 99 })).toEqual(DEFAULT_SCRAPER_CONFIG);
  });

  it('kısmi güncelleme doğrulanır; hata alan yoluyla döner', () => {
    const ok = applyScraperConfigPatch(DEFAULT_SCRAPER_CONFIG, { sources: { kariyer_net: { max_pages: 3 } }, keywords: ['Flutter Developer'] });
    expect('config' in ok && ok.config.sources.kariyer_net.max_pages).toBe(3);
    expect('config' in ok && ok.config.sources.indeed.enabled).toBe(true);
    const bad = applyScraperConfigPatch(DEFAULT_SCRAPER_CONFIG, { sources: { indeed: { interval_hours: 0 } }, cities: [] });
    expect('errors' in bad && bad.errors).toEqual(expect.arrayContaining([expect.stringContaining('sources.indeed.interval_hours'), expect.stringContaining('cities')]));
    expect('errors' in applyScraperConfigPatch(DEFAULT_SCRAPER_CONFIG, [1])).toBe(true);
  });

  it('siteye özel şehir/anahtar kelime genel listeyi ezer', () => {
    const c = resolveScraperConfig({ sources: { indeed: { cities: ['Ankara'], keywords: ['iOS'] } }, keywords: ['Flutter'] });
    expect(sourceTargets(c, 'indeed')).toEqual({ cities: ['Ankara'], keywords: ['iOS'] });
    expect(sourceTargets(c, 'kariyer_net')).toEqual({ cities: DEFAULT_SCRAPER_CONFIG.cities, keywords: ['Flutter'] });
  });

  it('anahtar kelime kipi: Kariyer.net doğrulanmış arama adresi olmadığı için her zaman yerel süzgeç', () => {
    expect(kariyer.keywordModeOf('query')).toBe('local_filter');
    expect(indeed.keywordModeOf('query')).toBe('query');
    expect(kariyer.targets(['İstanbul', 'Ankara'], ['flutter'], 'local_filter')).toEqual([
      { city: 'İstanbul', keyword: null },
      { city: 'Ankara', keyword: null },
    ]);
    expect(indeed.targets(['İstanbul'], ['flutter', 'ios'], 'query')).toEqual([
      { city: 'İstanbul', keyword: 'flutter' },
      { city: 'İstanbul', keyword: 'ios' },
    ]);
    expect(indeed.targets(['İstanbul'], [], 'query')).toEqual([{ city: 'İstanbul', keyword: null }]);
  });
});

describe('ScrapeError', () => {
  it('türünü ve ayrıntıyı taşır', () => {
    const e = new ScrapeError('blocked', 'x', { status: 403 });
    expect(e).toBeInstanceOf(Error);
    expect(e.kind).toBe('blocked');
    expect(e.detail.status).toBe(403);
  });
});
