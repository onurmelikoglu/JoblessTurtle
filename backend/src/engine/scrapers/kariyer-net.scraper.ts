import { plateOf, provinceByPlate, provinceOfSlug } from '../../domain/provinces';
import { BaseScraper, BrowserSearch, ImportedSearch } from './base-scraper';
import { KARIYER_NET_BROWSER_SCRIPT, kariyerNetFromBrowser } from './parsers/kariyer-net.browser';
import { kariyerCitySlug, parseKariyerNetPage } from './parsers/kariyer-net.parser';
import { KARIYER_NET } from './selectors/kariyer-net';
import { PageContext, ParsedPage, SearchTarget } from './types';

/**
 * Kariyer.net şehir sayfaları (/is-ilanlari/<şehir>, -2, -3 …). Anahtar kelimeli arama adresi doğrulanamadığı için
 * (bot koruması) ilanlar yerelde süzülür.
 */
export class KariyerNetScraper extends BaseScraper {
  readonly source = 'kariyer_net' as const;
  readonly label = 'Kariyer.net';
  readonly origin = KARIYER_NET.origin;
  readonly blockMarkers = KARIYER_NET.blockMarkers;
  readonly supportsKeywordQuery = false;
  readonly searchPagePath = KARIYER_NET.searchPagePath;

  searchUrl(target: SearchTarget, page: number): string {
    return `${this.origin}${KARIYER_NET.cityPath(kariyerCitySlug(target.city), page)}`;
  }

  /**
   * Kullanıcının tarayıcısında anahtar kelimeli arama açılabiliyor (23 Ekim 2026'da doğrulandı: site adresi
   * "?ct=34,82&kw=…" biçimine çevirir, sayfalar "&cp=N"); sunucu taraması aynı adreste doğrulamaya takıldığı için
   * şehir sayfasını kullanır.
   */
  browserSearchUrl(target: SearchTarget): string {
    const base = this.searchUrl(target, 1);
    return target.keyword ? `${base}?${KARIYER_NET.keywordQuery}=${encodeURIComponent(target.keyword)}` : base;
  }

  /** Pozisyon başına bir arama, şehirlerin hepsi aynı aramada ("ct" kodları); pozisyon yoksa şehir sayfaları. */
  browserSearches(titles: string[], cities: string[]): BrowserSearch[] {
    const codes = [...new Set(cities.flatMap(kariyerCityCodes))];
    if (!titles.length || !codes.length) return super.browserSearches(titles, cities);
    return titles.map((keyword) => ({ cities, keywords: [keyword], url: `${this.origin}/is-ilanlari?${KARIYER_NET.cityCodesQuery}=${codes.join(',')}&${KARIYER_NET.keywordQuery}=${encodeURIComponent(keyword)}` }));
  }

  protected parse(html: string, ctx: PageContext): ParsedPage {
    return parseKariyerNetPage(html, { citySlug: kariyerCitySlug(ctx.target.city), page: ctx.page });
  }

  browserScript(): string {
    return KARIYER_NET_BROWSER_SCRIPT;
  }

  fromBrowser(payload: unknown, url: string): ParsedPage {
    return kariyerNetFromBrowser(payload, url);
  }

  /**
   * /is-ilanlari/<ek>(-N): ekin ilk parçası ("istanbul+avrupa-sisli" → "istanbul") bir ilin adres ekiyse şehir odur;
   * /is-ilanlari?ct=34,82,41: şehirler kodlardan. Pozisyon sayfalarında şehir adresten okunamaz.
   */
  searchOfPage(url: URL): ImportedSearch | null {
    if (url.origin !== this.origin) return null;
    const match = url.pathname.match(KARIYER_NET.searchPagePath);
    if (!match) return null;
    const keyword = url.searchParams.get(KARIYER_NET.keywordQuery)?.trim() || null;
    const fromCodes = (url.searchParams.get(KARIYER_NET.cityCodesQuery) ?? '').split(',').map((code) => kariyerCityOfCode(Number(code)));
    const cities = [...new Set([provinceOfSlug(match[1]), ...fromCodes].filter((c): c is string => !!c))];
    return { cities, keyword };
  }
}

/** İlin Kariyer.net şehir kodları: plaka kodu; İstanbul iki yakasıyla iki kod. */
export function kariyerCityCodes(city: string): number[] {
  const plate = plateOf(city);
  if (plate === null) return [];
  return plate === KARIYER_NET.istanbulCodes[0] ? [...KARIYER_NET.istanbulCodes] : [plate];
}

export function kariyerCityOfCode(code: number): string | null {
  if (!Number.isInteger(code)) return null;
  return (KARIYER_NET.istanbulCodes as readonly number[]).includes(code) ? provinceByPlate(KARIYER_NET.istanbulCodes[0]) : provinceByPlate(code);
}
