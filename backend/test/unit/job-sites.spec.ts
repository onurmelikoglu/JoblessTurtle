import { readFileSync } from 'fs';
import { join } from 'path';
import { openFromUrl, sealForUrl } from '../../src/common/crypto';
import { citySlug, plateOf, provinceOfSlug } from '../../src/domain/provinces';
import { isConfidentialCompany, isRejection, normalizeCard, relativeDate, ScrapedListing, splitLocation } from '../../src/domain/scraped-jobs';
import { DEFAULT_SCRAPER_CONFIG, resolveScraperConfig, SCRAPER_SOURCES } from '../../src/domain/scraper-config';
import { ElemanNetScraper } from '../../src/engine/scrapers/eleman-net.scraper';
import { IndeedScraper } from '../../src/engine/scrapers/indeed.scraper';
import { IsinolsunScraper } from '../../src/engine/scrapers/isinolsun.scraper';
import { kariyerCityCodes, KariyerNetScraper } from '../../src/engine/scrapers/kariyer-net.scraper';
import { isinolsunAge, isinolsunLocation } from '../../src/engine/scrapers/parsers/isinolsun.parser';
import { yenibirisTags } from '../../src/engine/scrapers/parsers/yenibiris.parser';
import { SCRAPERS } from '../../src/engine/scrapers/registry';
import { SecretcvScraper } from '../../src/engine/scrapers/secretcv.scraper';
import { FetchedPage, PageContext, ParsedPage, ScrapeError } from '../../src/engine/scrapers/types';
import { YenibirisScraper } from '../../src/engine/scrapers/yenibiris.scraper';

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', 'scrapers', name), 'utf8');
const NOW = new Date('2026-10-23T09:00:00Z');
const eleman = new ElemanNetScraper();
const isinolsun = new IsinolsunScraper();
const secretcv = new SecretcvScraper();
const yenibiris = new YenibirisScraper();
const ctx = (city = 'İstanbul', page = 1): PageContext => ({ url: `https://example.test/${page}`, target: { city, keyword: null }, page });
const page = (html: string): FetchedPage => ({ status: 200, url: 'https://example.test', html });

function listings(scraper: { source: ScrapedListing['source']; origin: string }, parsed: ParsedPage, city = 'İstanbul'): ScrapedListing[] {
  return parsed.cards.map((card) => normalizeCard(scraper.source, card, { origin: scraper.origin, searchedCity: city, now: NOW })).filter((l): l is ScrapedListing => !isRejection(l));
}

function errorOf(fn: () => unknown): ScrapeError {
  try {
    fn();
  } catch (e) {
    return e as ScrapeError;
  }
  throw new Error('hata bekleniyordu');
}

const browserPayload = (source: string, cards: (string | number | null)[][], extra: Record<string, unknown> = {}) => ({ v: 1, source, url: 'https://example.test', marker: null, root: true, next: false, cards, ...extra });

describe('Eleman.net', () => {
  const parsed = eleman.parsePage(page(fixture('eleman-net-istanbul.html')), ctx());

  it('kartlardan unvan, firma, konum, açıklama ve ilan numarası; başlıktaki rozetler atılır', () => {
    expect(parsed.cards).toHaveLength(3);
    expect(parsed.hasNextPage).toBe(true);
    expect(parsed.cards[1]).toMatchObject({ platformId: '4900102', title: 'Flutter Geliştirici', company: 'Kabuk Yazılım Anonim Şirketi', location: 'İstanbul Avrupa - Esenyurt', description: 'Mobil uygulama ekibimize Flutter geliştirici arıyoruz...' });
    const [hidden, flutter, waiter] = listings(eleman, parsed);
    expect(flutter).toMatchObject({ externalId: '4900102', city: 'İstanbul', district: 'Esenyurt', jobUrl: 'https://www.eleman.net/is-ilani/flutter-gelistirici-i4900102' });
    expect(waiter).toMatchObject({ city: 'İstanbul', district: null });
    expect(isConfidentialCompany(hidden.companyName)).toBe(true);
  });

  it('arama adresi: anahtar kelimeyle site araması, yoksa şehir sayfası; sayfalar "sy"', () => {
    expect(eleman.searchUrl({ city: 'İstanbul', keyword: null }, 1)).toBe('https://www.eleman.net/is-ilanlari/istanbul');
    expect(eleman.searchUrl({ city: 'İstanbul', keyword: null }, 2)).toBe('https://www.eleman.net/is-ilanlari/istanbul?sy=2');
    expect(eleman.searchUrl({ city: 'İzmir', keyword: 'Flutter Developer' }, 2)).toBe('https://www.eleman.net/is-ilanlari?aranan=Flutter+Developer&sehir=%C4%B0zmir&sy=2');
    expect(eleman.browserSearchUrl({ city: 'İzmir', keyword: 'Flutter Developer' })).toBe('https://www.eleman.net/is-ilanlari?aranan=Flutter+Developer&sehir=%C4%B0zmir');
  });

  it('eklentinin gönderdiği adres', () => {
    expect(eleman.searchOfPage(new URL('https://www.eleman.net/is-ilanlari/istanbul-anadolu?sy=2'))).toEqual({ cities: ['İstanbul'], keyword: null });
    expect(eleman.searchOfPage(new URL('https://www.eleman.net/is-ilanlari?aranan=yaz%C4%B1l%C4%B1m&arandi=e&sehir=%C4%B0zmir'))).toEqual({ cities: ['İzmir'], keyword: 'yazılım' });
    expect(eleman.searchOfPage(new URL('https://www.eleman.net/is-ilani/garson-i4900103'))).toBeNull();
    expect(eleman.searchOfPage(new URL('https://eleman.net/is-ilanlari/istanbul'))).toBeNull();
  });

  it('tarayıcı verisi', () => {
    const fromBrowser = eleman.fromBrowser(browserPayload('eleman_net', [['https://www.eleman.net/is-ilani/flutter-gelistirici-i4900102', 'Flutter Geliştirici', 'Kabuk Yazılım', 'İstanbul Avrupa - Esenyurt', 'Açıklama']], { next: true }), 'https://www.eleman.net/is-ilanlari/istanbul');
    expect(fromBrowser).toEqual({ hasNextPage: true, cards: [expect.objectContaining({ platformId: '4900102', company: 'Kabuk Yazılım', location: 'İstanbul Avrupa - Esenyurt', description: 'Açıklama' })] });
    expect(errorOf(() => eleman.fromBrowser(browserPayload('eleman_net', [], { root: false, marker: 'cf_chl_opt' }), 'https://www.eleman.net/is-ilanlari')).kind).toBe('blocked');
  });

  it('düzeni değişmiş sayfa "selector", doğrulama sayfası "blocked"', () => {
    expect(errorOf(() => eleman.parsePage(page('<html><body><p>Bakım</p></body></html>'), ctx())).kind).toBe('selector');
    expect(errorOf(() => eleman.parsePage(page(fixture('indeed-blocked.html')), ctx())).kind).toBe('blocked');
  });
});

describe('İşin Olsun', () => {
  const parsed = isinolsun.parsePage(page(fixture('isinolsun-istanbul.html')), ctx());

  it('sunucuda gömülü veri okunur; sonraki sayfa pageNumber < pageCount', () => {
    expect(parsed.hasNextPage).toBe(true);
    expect(parsed.cards[0]).toMatchObject({ platformId: 'AAAABBBBCCCCDDDDEEEEFFFF00001111', title: 'Barista', company: 'Kabuk Kahve', location: 'İstanbul - Şişli', employmentType: 'Tam zamanlı', publishedText: '2 saat' });
    expect(parsed.cards[1]).toMatchObject({ location: 'İstanbul', employmentType: null, publishedText: '15+ gün' });
    const [barista, mobile] = listings(isinolsun, parsed);
    expect(barista).toMatchObject({ externalId: 'AAAABBBBCCCCDDDDEEEEFFFF00001111', city: 'İstanbul', district: 'Şişli', publishedAt: new Date('2026-10-23T00:00:00Z') });
    expect(mobile.publishedAt).toBeNull();
  });

  it('gömülü veri yoksa "selector", bozuksa "parse"', () => {
    expect(errorOf(() => isinolsun.parsePage(page('<html><body></body></html>'), ctx())).kind).toBe('selector');
    expect(errorOf(() => isinolsun.parsePage(page('<html><body><script id="__NEXT_DATA__">{bozuk</script></body></html>'), ctx())).kind).toBe('parse');
  });

  it('tarayıcıda kart adresi il ve ilçeye çevrilir (mahalle atılır); ilan numarası adresin sonundan', () => {
    const fromBrowser = isinolsun.fromBrowser(
      browserPayload('isinolsun', [['https://isinolsun.com/is-ilani/barista-kabuk-kahve-0iojAAAABBBBCCCCDDDDEEEEFFFF00001111', 'Barista', 'Kabuk Kahve', 'Cumhuriyet Mah., Şişli, İstanbul', 'Part Time']]),
      'https://isinolsun.com/is-ilanlari/istanbul?pn=2',
    );
    expect(fromBrowser.cards[0]).toMatchObject({ platformId: 'AAAABBBBCCCCDDDDEEEEFFFF00001111', location: 'İstanbul - Şişli', employmentType: 'Part Time' });
    expect(isinolsunLocation('Kadıköy, İstanbul')).toBe('İstanbul - Kadıköy');
    expect(isinolsunLocation('İstanbul')).toBe('İstanbul');
    expect(isinolsunAge('3g')).toBe('3 gün');
  });

  it('arama adresi ve eklentinin gönderdiği adres', () => {
    expect(isinolsun.searchUrl({ city: 'İstanbul', keyword: null }, 2)).toBe('https://isinolsun.com/is-ilanlari/istanbul?pn=2');
    expect(isinolsun.searchUrl({ city: 'İstanbul', keyword: 'garson' }, 1)).toBe('https://isinolsun.com/is-ilanlari?kw=garson&lc=%C4%B0stanbul');
    expect(isinolsun.searchOfPage(new URL('https://isinolsun.com/is-ilanlari?kw=yaz%C4%B1l%C4%B1m&lc=%C4%B0stanbul'))).toEqual({ cities: ['İstanbul'], keyword: 'yazılım' });
    expect(isinolsun.searchOfPage(new URL('https://isinolsun.com/is-ilanlari/istanbul-sofor-surucu'))).toEqual({ cities: ['İstanbul'], keyword: null });
    expect(isinolsun.searchOfPage(new URL('https://www.isinolsun.com/is-ilanlari/istanbul'))).toBeNull();
  });
});

describe('Secretcv', () => {
  const parsed = secretcv.parsePage(page(fixture('secretcv-istanbul.html')), ctx());

  it('kartlar okunur; robots.txt sayfalamayı yasakladığı için sunucuda sonraki sayfa yok', () => {
    expect(parsed.hasNextPage).toBe(false);
    expect(parsed.cards[0]).toMatchObject({ platformId: '1890001', title: 'Finans Uzmanı', company: 'Kabuk Lojistik A.Ş.', location: 'İstanbul Avrupa', publishedText: 'Bugün' });
    expect(listings(secretcv, parsed).map((l) => [l.city, l.district])).toEqual([
      ['İstanbul', null],
      ['İstanbul', null],
    ]);
  });

  it('sunucu yalnız şehir sayfası (anahtar kelime yerelde süzülür); eklenti için anahtar kelimeli arama', () => {
    expect(secretcv.keywordModeOf('query')).toBe('local_filter');
    expect(secretcv.searchUrl({ city: 'İstanbul', keyword: null }, 2)).toBe('https://www.secretcv.com/is-ilanlari/istanbul-is-ilanlari');
    expect(secretcv.browserSearchUrl({ city: 'İstanbul', keyword: 'Flutter Developer' })).toBe('https://www.secretcv.com/is-ilanlari/ara-is-ilanlari?k=Flutter%20Developer');
    expect(secretcv.searchOfPage(new URL('https://www.secretcv.com/is-ilanlari/istanbul-is-ilanlari/?sf=2'))).toEqual({ cities: ['İstanbul'], keyword: null });
    expect(secretcv.searchOfPage(new URL('https://www.secretcv.com/is-ilanlari/ara-is-ilanlari?k=yaz%C4%B1l%C4%B1m'))).toEqual({ cities: [], keyword: 'yazılım' });
    expect(secretcv.searchOfPage(new URL('https://www.secretcv.com/kabuk-lojistik/finans-uzmani-is-ilanlari-1890001'))).toBeNull();
  });

  it('tarayıcıda sonraki sayfa bilinir; "İlan Tarihi:" öneki atılır', () => {
    const fromBrowser = secretcv.fromBrowser(browserPayload('secretcv', [['https://www.secretcv.com/kabuk-lojistik/finans-uzmani-is-ilanlari-1890001', 'Finans Uzmanı', 'Kabuk Lojistik', 'İnegöl', 'İlan Tarihi: Dün']], { next: true }), 'https://www.secretcv.com/is-ilanlari/ara-is-ilanlari?k=x');
    expect(fromBrowser).toEqual({ hasNextPage: true, cards: [expect.objectContaining({ platformId: '1890001', publishedText: 'Dün' })] });
  });
});

describe('Yenibiriş (yalnızca eklenti)', () => {
  it('sunucu taraması kapalı; ayarda da varsayılan kapalı', () => {
    expect(yenibiris.serverScraping).toBe(false);
    expect(DEFAULT_SCRAPER_CONFIG.sources.yenibiris.enabled).toBe(false);
    expect(SCRAPER_SOURCES.filter((source) => !SCRAPERS[source].serverScraping)).toEqual(['yenibiris']);
  });

  it('kayıtlı sayfa ve tarayıcı verisi aynı alanları verir; reklam satırı kart sayılmaz', () => {
    const parsed = yenibiris.parsePage(page(fixture('yenibiris-istanbul.html')), ctx());
    expect(parsed.hasNextPage).toBe(true);
    expect(parsed.cards).toHaveLength(2);
    expect(parsed.cards[0]).toMatchObject({ platformId: '1300001', title: 'Mobil Geliştirici', company: 'Kabuk Teknoloji A.Ş.', location: 'İstanbul Anadolu Yakası - Kadıköy', employmentType: 'Tam zamanlı', workModeText: 'Hibrit', publishedText: 'Bugün' });
    const fromBrowser = yenibiris.fromBrowser(browserPayload('yenibiris', [['https://www.yenibiris.com/is-ilani/mobil-gelistirici/1300001', 'Mobil Geliştirici', 'Kabuk Teknoloji A.Ş.', 'İstanbul Anadolu Yakası - Kadıköy', 'Bugün', 'Tam zamanlı|Hibrit']]), 'https://www.yenibiris.com/is-ilanlari/istanbul');
    expect(fromBrowser.cards[0]).toEqual(parsed.cards[0]);
    const [mobile, accounting] = listings(yenibiris, parsed);
    expect(mobile).toMatchObject({ city: 'İstanbul', district: 'Kadıköy', workMode: 'hybrid' });
    expect(accounting).toMatchObject({ city: 'İstanbul', district: null, workMode: 'onsite', publishedAt: null, publishedText: 'Son 1 Hafta' });
  });

  it('arama adresi ve eklentinin gönderdiği adres', () => {
    expect(yenibiris.browserSearchUrl({ city: 'İstanbul', keyword: 'yazılım' })).toBe('https://www.yenibiris.com/is-ilanlari/istanbul?q=yaz%C4%B1l%C4%B1m');
    expect(yenibiris.searchUrl({ city: 'İstanbul', keyword: 'yazılım' }, 2)).toBe('https://www.yenibiris.com/is-ilanlari/istanbul?q=yaz%C4%B1l%C4%B1m&sayfa=2');
    expect(yenibiris.searchOfPage(new URL('https://www.yenibiris.com/is-ilanlari/istanbul?q=yaz%C4%B1l%C4%B1m&sayfa=2'))).toEqual({ cities: ['İstanbul'], keyword: 'yazılım' });
    expect(yenibiris.searchOfPage(new URL('https://www.yenibiris.com/is-ilani/mobil-gelistirici/1300001'))).toBeNull();
    expect(yenibirisTags(['Yarı Zamanlı / Part-Time', 'İş Yerinde'])).toEqual({ employmentType: 'Yarı Zamanlı / Part-Time', workModeText: 'İş Yerinde' });
  });
});

describe('ortak kurallar', () => {
  it('İstanbul yaka adları il adına iner; tekrar eden konum parçaları birleşir', () => {
    expect(splitLocation('İstanbul Anadolu Yakası - Sancaktepe, İstanbul Anadolu Yakası - Sancaktepe', null)).toEqual({ city: 'İstanbul', district: 'Sancaktepe' });
    expect(splitLocation('İstanbul Avrupa', 'İstanbul')).toEqual({ city: 'İstanbul', district: null });
    expect(splitLocation('İstanbul Anadolu, İstanbul Avrupa', null)).toEqual({ city: 'İstanbul', district: null });
  });

  it('"Son 1 Hafta" gibi aralıklardan tarih üretilmez', () => {
    expect(relativeDate('Son 1 Hafta', NOW)).toBeNull();
    expect(relativeDate('Son 1 Ay', NOW)).toBeNull();
    expect(relativeDate('3 gün önce', NOW)).toEqual(new Date('2026-10-20T00:00:00Z'));
  });

  it('il adres eki', () => {
    expect(citySlug('Kahramanmaraş')).toBe('kahramanmaras');
    expect(provinceOfSlug('istanbul-anadolu')).toBe('İstanbul');
    expect(provinceOfSlug('istanbul+avrupa-sisli')).toBe('İstanbul');
    expect(provinceOfSlug('yazilim')).toBeNull();
  });

  it('eski kayıtlı ayar yeni sitelerin varsayılanlarıyla tamamlanır', () => {
    const config = resolveScraperConfig({ sources: { kariyer_net: { max_pages: 2 }, indeed: { enabled: false } } });
    expect(Object.keys(config.sources)).toEqual([...SCRAPER_SOURCES]);
    expect(config.sources.kariyer_net.max_pages).toBe(2);
    expect(config.sources.eleman_net).toEqual(DEFAULT_SCRAPER_CONFIG.sources.eleman_net);
  });

  it('her sitenin okuma betiği, arama sayfası yolu ve etiketi var; betikler istek atmaz, gezinmez', () => {
    for (const source of SCRAPER_SOURCES) {
      const scraper = SCRAPERS[source];
      expect(scraper.source).toBe(source);
      expect(scraper.browserScript()).toContain(`source: '${source}'`);
      expect(scraper.browserScript()).not.toMatch(/fetch\(|XMLHttpRequest|\.click\(|location\.(assign|replace|href\s*=)|sendBeacon|\.submit\(/);
      expect(scraper.searchOfPage(new URL(scraper.browserSearchUrl({ city: 'İstanbul', keyword: 'Flutter Developer' })))).not.toBeNull();
      expect(scraper.searchOfPage(new URL(scraper.browserSearchUrl({ city: 'Ankara', keyword: null })))).toMatchObject({ cities: ['Ankara'] });
    }
  });
});

describe('birleşik tarayıcı aramaları (en az sayıda arama)', () => {
  const titles = ['Creative Director', 'Art Director'];
  const cities = ['İstanbul', 'Kocaeli'];
  const kariyer = new KariyerNetScraper();
  const indeed = new IndeedScraper();

  it('Kariyer.net: pozisyon başına bir arama, bütün şehirler "ct" kodlarıyla (İstanbul iki yaka: 34 ve 82)', () => {
    expect(kariyerCityCodes('İstanbul')).toEqual([34, 82]);
    expect(kariyerCityCodes('Kocaeli')).toEqual([41]);
    expect(kariyerCityCodes('Türkiye')).toEqual([]);
    expect(kariyer.browserSearches(titles, cities)).toEqual([
      { cities, keywords: ['Creative Director'], url: 'https://www.kariyer.net/is-ilanlari?ct=34,82,41&kw=Creative%20Director' },
      { cities, keywords: ['Art Director'], url: 'https://www.kariyer.net/is-ilanlari?ct=34,82,41&kw=Art%20Director' },
    ]);
    expect(kariyer.searchOfPage(new URL('https://www.kariyer.net/is-ilanlari?ct=34%2C82%2C41&kw=creative+director&cp=2'))).toEqual({ cities: ['İstanbul', 'Kocaeli'], keyword: 'creative director' });
    expect(kariyer.browserSearches([], ['Ankara']).map((s) => s.url)).toEqual(['https://www.kariyer.net/is-ilanlari/ankara']);
  });

  it('Indeed: şehir başına bir arama, pozisyonlar VEYA ile; tek pozisyonda düz arama', () => {
    expect(indeed.browserSearches(titles, cities)).toEqual([
      { cities: ['İstanbul'], keywords: titles, url: 'https://tr.indeed.com/jobs?q=%22Creative%20Director%22%20or%20%22Art%20Director%22&l=%C4%B0stanbul&sort=date' },
      { cities: ['Kocaeli'], keywords: titles, url: 'https://tr.indeed.com/jobs?q=%22Creative%20Director%22%20or%20%22Art%20Director%22&l=Kocaeli&sort=date' },
    ]);
    expect(indeed.browserSearches(['Flutter Developer'], ['İstanbul']).map((s) => s.url)).toEqual(['https://tr.indeed.com/jobs?q=Flutter%20Developer&l=%C4%B0stanbul&sort=date']);
  });

  it('Eleman.net ve Secretcv: pozisyon başına bir arama, şehirsiz (şehir aktarımda süzülür)', () => {
    expect(eleman.browserSearches(titles, cities)).toEqual([
      { cities: [], keywords: ['Creative Director'], url: 'https://www.eleman.net/is-ilanlari?aranan=Creative+Director' },
      { cities: [], keywords: ['Art Director'], url: 'https://www.eleman.net/is-ilanlari?aranan=Art+Director' },
    ]);
    expect(secretcv.browserSearches(titles, cities).map((s) => [s.cities, s.url])).toEqual([
      [[], 'https://www.secretcv.com/is-ilanlari/ara-is-ilanlari?k=Creative%20Director'],
      [[], 'https://www.secretcv.com/is-ilanlari/ara-is-ilanlari?k=Art%20Director'],
    ]);
  });

  it('İşin Olsun ve Yenibiriş: çoklu şehir ve VEYA desteklenmiyor, pozisyon × şehir', () => {
    expect(isinolsun.browserSearches(titles, cities)).toHaveLength(4);
    expect(yenibiris.browserSearches(titles, cities).map((s) => s.url)).toEqual([
      'https://www.yenibiris.com/is-ilanlari/istanbul?q=Creative+Director',
      'https://www.yenibiris.com/is-ilanlari/kocaeli?q=Creative+Director',
      'https://www.yenibiris.com/is-ilanlari/istanbul?q=Art+Director',
      'https://www.yenibiris.com/is-ilanlari/kocaeli?q=Art+Director',
    ]);
  });

  it('her sitenin bütün aramaları o sitenin arama sayfası olarak tanınır', () => {
    for (const source of SCRAPER_SOURCES) for (const search of SCRAPERS[source].browserSearches(titles, cities)) expect(SCRAPERS[source].searchOfPage(new URL(search.url))).not.toBeNull();
    expect(plateOf('Kahramanmaraş')).toBe(46);
  });
});

describe('aramanın hedef etiketi', () => {
  it('şifreli, adreste taşınabilir; başka amaçla ya da bozulmuş değer açılmaz', () => {
    const tag = sealForUrl('jt-import-target', 'ws_kabuk');
    expect(tag).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(tag).not.toContain('ws_kabuk');
    expect(openFromUrl('jt-import-target', tag)).toBe('ws_kabuk');
    expect(openFromUrl('baska-amac', tag)).toBeNull();
    const tampered = `${tag.slice(0, 20)}${tag[20] === 'A' ? 'B' : 'A'}${tag.slice(21)}`;
    expect(openFromUrl('jt-import-target', tampered)).toBeNull();
    expect(openFromUrl('jt-import-target', 'bozuk')).toBeNull();
  });
});
