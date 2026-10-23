import { citySlug, provinceOfSlug } from '../../domain/provinces';
import { BaseScraper, BrowserSearch, ImportedSearch } from './base-scraper';
import { ELEMAN_NET_BROWSER_SCRIPT, elemanNetFromBrowser } from './parsers/eleman-net.browser';
import { parseElemanNetPage } from './parsers/eleman-net.parser';
import { ELEMAN_NET } from './selectors/eleman-net';
import { PageContext, ParsedPage, SearchTarget } from './types';

/**
 * Eleman.net: anahtar kelime varsa site araması (/is-ilanlari?aranan=…&sehir=…), yoksa şehir sayfası
 * (/is-ilanlari/<şehir>); sayfalar "sy" parametresiyle. Sunucudan erişim açık, robots.txt bu adreslere izin veriyor.
 */
export class ElemanNetScraper extends BaseScraper {
  readonly source = 'eleman_net' as const;
  readonly label = 'Eleman.net';
  readonly origin = ELEMAN_NET.origin;
  readonly blockMarkers = ELEMAN_NET.blockMarkers;
  readonly supportsKeywordQuery = true;
  readonly searchPagePath = ELEMAN_NET.searchPagePath;

  searchUrl(target: SearchTarget, page: number): string {
    const params = new URLSearchParams();
    if (target.keyword) {
      params.set(ELEMAN_NET.keywordQuery, target.keyword);
      params.set(ELEMAN_NET.cityQuery, target.city);
    }
    if (page > 1) params.set(ELEMAN_NET.pageQuery, String(page));
    const query = params.toString();
    return `${this.origin}${target.keyword ? ELEMAN_NET.searchPath : ELEMAN_NET.cityPath(citySlug(target.city))}${query ? `?${query}` : ''}`;
  }

  /**
   * Pozisyon başına bir arama, şehirsiz: 23 Ekim 2026'da aramadaki "sehir" parametresinin süzmediği görüldü (Kocaeli
   * istendi, sonuçlar ülke geneli), şehir yoluna eklenen anahtar kelime ise bölüm sayfasına ya da düz şehir sayfasına
   * yönlendiriliyor. Şehir süzgeci ilanlar profile aktarılırken uygulanır. Pozisyon yoksa şehir sayfaları.
   */
  browserSearches(titles: string[], cities: string[]): BrowserSearch[] {
    if (!titles.length) return super.browserSearches(titles, cities);
    return titles.map((keyword) => ({ cities: [], keywords: [keyword], url: `${this.origin}${ELEMAN_NET.searchPath}?${new URLSearchParams({ [ELEMAN_NET.keywordQuery]: keyword })}` }));
  }

  protected parse(html: string, ctx: PageContext): ParsedPage {
    return parseElemanNetPage(html, { page: ctx.page });
  }

  browserScript(): string {
    return ELEMAN_NET_BROWSER_SCRIPT;
  }

  fromBrowser(payload: unknown, url: string): ParsedPage {
    return elemanNetFromBrowser(payload, url);
  }

  /** Şehir sayfasında şehir yoldan ("istanbul-anadolu" → İstanbul), aramada "sehir" parametresinden okunur. */
  searchOfPage(url: URL): ImportedSearch | null {
    if (url.origin !== this.origin) return null;
    const match = url.pathname.match(ELEMAN_NET.searchPagePath);
    if (!match) return null;
    const keyword = url.searchParams.get(ELEMAN_NET.keywordQuery)?.trim() || null;
    const city = provinceOfSlug(match[1]) ?? (url.searchParams.get(ELEMAN_NET.cityQuery)?.trim() || null);
    return { cities: city ? [city] : [], keyword };
  }
}
