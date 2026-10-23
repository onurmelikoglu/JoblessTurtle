import { readFileSync } from 'fs';
import { join } from 'path';
import { isRejection, normalizeCard } from '../../src/domain/scraped-jobs';
import { SCRAPER_SOURCES, searchTargetsOf } from '../../src/domain/scraper-config';
import { EXTRACTORS_PATH, renderExtractors } from '../../src/engine/scrapers/extension-extractors';
import { IndeedScraper } from '../../src/engine/scrapers/indeed.scraper';
import { KariyerNetScraper } from '../../src/engine/scrapers/kariyer-net.scraper';
import { ScrapeError } from '../../src/engine/scrapers/types';

const NOW = new Date('2026-10-23T09:00:00Z');
const kariyer = new KariyerNetScraper();
const indeed = new IndeedScraper();
const KARIYER_URL = 'https://www.kariyer.net/is-ilanlari/istanbul';
const INDEED_URL = 'https://tr.indeed.com/jobs?q=flutter&l=%C4%B0stanbul';

const page = (source: string, cards: (string | number | null)[][], extra: Record<string, unknown> = {}) => ({ v: 1, source, url: 'https://example.test', marker: null, root: true, next: false, cards, ...extra });

function errorOf(fn: () => unknown): ScrapeError {
  try {
    fn();
  } catch (e) {
    return e as ScrapeError;
  }
  throw new Error('hata bekleniyordu');
}

describe('Kariyer.net tarayıcı verisi', () => {
  const cards = [
    ['/is-ilani/kaplumbaga-yazilim-flutter-developer-4500102?from=list', 'Flutter Developer', 'Kaplumbağa Yazılım A.Ş.', 'İstanbul(Asya) - Kadıköy', 'Tam zamanlı', 'Hibrit', 'Bugün', 'Default'],
    ['/is-ilani/ornek-emlak-gayrimenkul-danismani-4500101', 'Örnek Emlak Grubu-Gayrimenkul Danışmanı', 'Örnek Emlak Grubu', 'İstanbul(Avr.)', 'Tam zamanlı', 'İş Yerinde', '2 gün', 'Updated'],
    ['/is-ilani/firmasiz-ilan-4500103', 'Muhasebe Uzmanı', null, 'İstanbul', null, null, null, null],
  ];

  it('kısa dizileri sunucudaki kart biçimine çevirir; firma öneki ve güncelleme tarihi ayrıştırıcıyla aynı', () => {
    const parsed = kariyer.fromBrowser(page('kariyer_net', cards, { next: true }), KARIYER_URL);
    expect(parsed.hasNextPage).toBe(true);
    expect(parsed.cards[0]).toMatchObject({ platformId: '4500102', title: 'Flutter Developer', company: 'Kaplumbağa Yazılım A.Ş.', employmentType: 'Tam zamanlı', workModeText: 'Hibrit', publishedText: 'Bugün', dateIsUpdate: false });
    expect(parsed.cards[1]).toMatchObject({ title: 'Gayrimenkul Danışmanı', dateIsUpdate: true });
    const listing = normalizeCard('kariyer_net', parsed.cards[0], { origin: kariyer.origin, searchedCity: 'İstanbul', now: NOW });
    expect(listing).toMatchObject({ externalId: '4500102', city: 'İstanbul', district: 'Kadıköy', jobUrl: 'https://www.kariyer.net/is-ilani/kaplumbaga-yazilim-flutter-developer-4500102', workMode: 'hybrid' });
  });

  it('ortak süzgeç: firmasız kart reddedilir, anahtar kelime kipi query iken her ilan kalır', () => {
    const parsed = kariyer.fromBrowser(page('kariyer_net', cards), KARIYER_URL);
    const rejected: string[] = [];
    const found = kariyer.listingsOf(parsed, 'İstanbul', { keywordMode: 'query', keywords: [], now: NOW }, (r) => rejected.push(r));
    expect(found.valid).toBe(2);
    expect(found.listings.map((l) => l.externalId)).toEqual(['4500102', '4500101']);
    expect(rejected).toEqual(['missing_company']);
    const filtered = kariyer.listingsOf(parsed, 'İstanbul', { keywordMode: 'local_filter', keywords: ['flutter'], now: NOW }, () => undefined);
    expect(filtered.listings.map((l) => l.jobTitle)).toEqual(['Flutter Developer']);
  });

  it('kartsız doğrulama sayfası "blocked", kartsız ve liste kökü olmayan sayfa "selector", bozuk veri "parse"', () => {
    expect(errorOf(() => kariyer.fromBrowser(page('kariyer_net', [], { marker: 'px-captcha', root: false }), KARIYER_URL)).kind).toBe('blocked');
    expect(errorOf(() => kariyer.fromBrowser(page('kariyer_net', [], { root: false }), KARIYER_URL)).kind).toBe('selector');
    expect(errorOf(() => kariyer.fromBrowser({ v: 2 }, KARIYER_URL)).kind).toBe('parse');
    expect(errorOf(() => kariyer.fromBrowser(page('indeed', cards), KARIYER_URL)).kind).toBe('parse');
    expect(errorOf(() => kariyer.fromBrowser(page('kariyer_net', Array.from({ length: 201 }, () => cards[0])), KARIYER_URL)).kind).toBe('parse');
  });

  it('kart varken sayfadaki koruma betiği işareti engel sayılmaz; boş sonuç sayfası hata değildir', () => {
    expect(kariyer.fromBrowser(page('kariyer_net', cards, { marker: 'window._pxAppId' }), KARIYER_URL).cards).toHaveLength(3);
    expect(kariyer.fromBrowser(page('kariyer_net', []), KARIYER_URL)).toEqual({ cards: [], hasNextPage: false });
  });
});

describe('Indeed tarayıcı verisi', () => {
  it('gömülü veriden gelen alanlar; konum il plakasıyla ilçeye bağlanır', () => {
    const parsed = indeed.fromBrowser(
      page('indeed', [
        ['0a1b2c3d4e5f6a7b', 'Flutter Developer', 'Kabuk Teknoloji', 'Kadıköy', 'T34', 0, 'Tam zamanlı', 1792000000000, '2 gün önce', '/cmp/Kabuk-Teknoloji'],
        ['1a1b2c3d4e5f6a7b', 'Mobile Developer', 'Yosun Yazılım', 'İstanbul', 'T34', 1, null, null, 'Bugün', null],
      ]),
      INDEED_URL,
    );
    expect(parsed.cards[0]).toMatchObject({ platformId: '0a1b2c3d4e5f6a7b', location: 'İstanbul - Kadıköy', url: '/viewjob?jk=0a1b2c3d4e5f6a7b', companyUrl: '/cmp/Kabuk-Teknoloji', employmentType: 'Tam zamanlı', publishedAt: new Date(1792000000000) });
    expect(parsed.cards[1]).toMatchObject({ location: 'İstanbul', workModeText: 'Uzaktan', publishedAt: null, publishedText: 'Bugün' });
    const listing = normalizeCard('indeed', parsed.cards[0], { origin: indeed.origin, searchedCity: 'İstanbul', now: NOW });
    expect(isRejection(listing) ? listing : listing.jobUrl).toBe('https://tr.indeed.com/viewjob?jk=0a1b2c3d4e5f6a7b');
  });

  it('Cloudflare doğrulama sayfası "blocked"; gömülü veri ve kart yoksa "selector"', () => {
    expect(errorOf(() => indeed.fromBrowser(page('indeed', [], { marker: 'cf_chl_opt', root: false }), INDEED_URL)).kind).toBe('blocked');
    expect(errorOf(() => indeed.fromBrowser(page('indeed', [], { root: false }), INDEED_URL)).kind).toBe('selector');
  });
});

describe('eklentinin gönderdiği adres', () => {
  const search = (scraper: KariyerNetScraper | IndeedScraper, url: string) => scraper.searchOfPage(new URL(url));

  it('Kariyer.net: şehir, sayfa numarası, ilçe ve pozisyon sayfaları; şehir yoldan okunur', () => {
    expect(search(kariyer, 'https://www.kariyer.net/is-ilanlari/istanbul')).toEqual({ cities: ['İstanbul'], keyword: null });
    expect(search(kariyer, 'https://www.kariyer.net/is-ilanlari/kahramanmaras-3')).toEqual({ cities: ['Kahramanmaraş'], keyword: null });
    expect(search(kariyer, 'https://www.kariyer.net/is-ilanlari/istanbul+asya-kadikoy?kw=flutter')).toEqual({ cities: ['İstanbul'], keyword: 'flutter' });
    expect(search(kariyer, 'https://www.kariyer.net/is-ilanlari/flutter-developer')).toEqual({ cities: [], keyword: null });
  });

  it('Kariyer.net: başka host, ilan ayrıntısı ve başka yollar reddedilir', () => {
    for (const url of ['https://kariyer.net/is-ilanlari/istanbul', 'https://www.kariyer.net.example.test/is-ilanlari/istanbul', 'http://www.kariyer.net/is-ilanlari/istanbul', 'https://www.kariyer.net/is-ilani/ilan-4500102', 'https://www.kariyer.net/is-ilanlari/istanbul/ilan', 'https://www.kariyer.net/is-ilanlarim'])
      expect(search(kariyer, url)).toBeNull();
  });

  it('Indeed: şehir "l", anahtar kelime "q"; başka yol ya da host reddedilir', () => {
    expect(search(indeed, INDEED_URL)).toEqual({ cities: ['İstanbul'], keyword: 'flutter' });
    expect(search(indeed, 'https://tr.indeed.com/jobs?q=&l=%C4%B0stanbul%2C+Kad%C4%B1k%C3%B6y&start=10')).toEqual({ cities: ['İstanbul'], keyword: null });
    expect(search(indeed, 'https://tr.indeed.com/jobs?q=flutter')).toEqual({ cities: [], keyword: 'flutter' });
    for (const url of ['https://tr.indeed.com/viewjob?jk=0a1b2c3d4e5f6a7b', 'https://www.indeed.com/jobs?q=flutter', 'https://tr.indeed.com.example.test/jobs?q=flutter'])
      expect(search(indeed, url)).toBeNull();
  });
});

describe('eklentinin okuma dosyası', () => {
  it('browser-extension/extractors.js sunucudaki betiklerden üretilmiş ve güncel (npm run extension:extractors)', () => {
    const onDisk = readFileSync(join(__dirname, '..', '..', '..', EXTRACTORS_PATH), 'utf8');
    expect(onDisk).toBe(renderExtractors());
  });

  it('her site için betik, köken ve arama sayfası yolu taşır; betik siteye istek atmaz ya da gezinmez', () => {
    const scope: { JT_EXTRACTORS?: Record<string, { origin: string; path: RegExp; read: () => string }> } = {};
    new Function('globalThis', renderExtractors())(scope);
    expect(Object.keys(scope.JT_EXTRACTORS ?? {})).toEqual([...SCRAPER_SOURCES]);
    expect(scope.JT_EXTRACTORS?.kariyer_net.path.test('/is-ilanlari/istanbul-2')).toBe(true);
    expect(scope.JT_EXTRACTORS?.indeed.path.test('/jobs')).toBe(true);
    expect(scope.JT_EXTRACTORS?.indeed.path.test('/viewjob')).toBe(false);
    for (const script of [kariyer.browserScript(), indeed.browserScript()]) expect(script).not.toMatch(/fetch\(|XMLHttpRequest|\.click\(|location\.(assign|replace|href\s*=)|sendBeacon|\.submit\(/);
  });
});

describe('eklenti aramaları', () => {
  it('profillerin aranan pozisyonlarının hepsi ve şehir seçimindeki iller; tekrarlar elenir', () => {
    expect(
      searchTargetsOf(
        [
          { titles: ['Flutter Developer', 'Mobile Developer', 'iOS Developer'], city: 'İstanbul; İstanbul (Anadolu Yakası); Kocaeli' },
          { titles: ['flutter developer'], city: 'istanbul' },
        ],
        ['Ankara'],
      ),
    ).toEqual({ titles: ['Flutter Developer', 'Mobile Developer', 'iOS Developer'], cities: ['İstanbul', 'Kocaeli'] });
    const many = Array.from({ length: 12 }, (_, i) => `Pozisyon ${i + 1}`);
    expect(searchTargetsOf([{ titles: many, city: 'Ankara' }], []).titles).toEqual(many.slice(0, 8));
  });

  it('profilde şehir yoksa tarama ayarındaki şehirler; unvan yoksa boş', () => {
    expect(searchTargetsOf([{ titles: [], city: null }], ['Ankara', 'İzmir'])).toEqual({ titles: [], cities: ['Ankara', 'İzmir'] });
  });
});
