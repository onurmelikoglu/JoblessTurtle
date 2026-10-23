import { citySlug, provinceOfSlug } from '../../domain/provinces';
import { BaseScraper, ImportedSearch } from './base-scraper';
import { ISINOLSUN_BROWSER_SCRIPT, isinolsunFromBrowser } from './parsers/isinolsun.browser';
import { parseIsinolsunPage } from './parsers/isinolsun.parser';
import { ISINOLSUN } from './selectors/isinolsun';
import { PageContext, ParsedPage, SearchTarget } from './types';

/**
 * İşin Olsun: anahtar kelime varsa site araması (/is-ilanlari?kw=…&lc=…), yoksa şehir sayfası (/is-ilanlari/<şehir>);
 * sayfalar "pn" parametresiyle. robots.txt tümüyle açık; ilanlar çoğunlukla mavi yaka ve hizmet sektörü.
 */
export class IsinolsunScraper extends BaseScraper {
  readonly source = 'isinolsun' as const;
  readonly label = 'İşin Olsun';
  readonly origin = ISINOLSUN.origin;
  readonly blockMarkers = ISINOLSUN.blockMarkers;
  readonly supportsKeywordQuery = true;
  readonly searchPagePath = ISINOLSUN.searchPagePath;

  searchUrl(target: SearchTarget, page: number): string {
    const params = new URLSearchParams();
    if (target.keyword) {
      params.set(ISINOLSUN.keywordQuery, target.keyword);
      params.set(ISINOLSUN.cityQuery, target.city);
    }
    if (page > 1) params.set(ISINOLSUN.pageQuery, String(page));
    const query = params.toString();
    return `${this.origin}${target.keyword ? ISINOLSUN.searchPath : ISINOLSUN.cityPath(citySlug(target.city))}${query ? `?${query}` : ''}`;
  }

  protected parse(html: string, _ctx: PageContext): ParsedPage {
    return parseIsinolsunPage(html);
  }

  browserScript(): string {
    return ISINOLSUN_BROWSER_SCRIPT;
  }

  fromBrowser(payload: unknown, url: string): ParsedPage {
    return isinolsunFromBrowser(payload, url);
  }

  /** Şehir yoldan ("istanbul-sofor-surucu" → İstanbul) ya da "lc" parametresinden, anahtar kelime "kw" parametresinden. */
  searchOfPage(url: URL): ImportedSearch | null {
    if (url.origin !== this.origin) return null;
    const match = url.pathname.match(ISINOLSUN.searchPagePath);
    if (!match) return null;
    const keyword = url.searchParams.get(ISINOLSUN.keywordQuery)?.trim() || null;
    const city = provinceOfSlug(match[1]) ?? (url.searchParams.get(ISINOLSUN.cityQuery)?.trim() || null);
    return { cities: city ? [city] : [], keyword };
  }
}
