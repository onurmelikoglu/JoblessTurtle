import { citySlug, provinceOfSlug } from '../../domain/provinces';
import { BaseScraper, BrowserSearch, ImportedSearch } from './base-scraper';
import { parseSecretcvPage } from './parsers/secretcv.parser';
import { SECRETCV_BROWSER_SCRIPT, secretcvFromBrowser } from './parsers/secretcv.browser';
import { SECRETCV } from './selectors/secretcv';
import { PageContext, ParsedPage, SearchTarget } from './types';

/**
 * Secretcv şehir sayfası (/is-ilanlari/<şehir>-is-ilanlari). robots.txt arama ve sayfalamayı yasakladığı için sunucu
 * yalnızca ilk sayfayı okur ve anahtar kelimeleri yerelde süzer; eklenti için anahtar kelimeli arama açılır.
 */
export class SecretcvScraper extends BaseScraper {
  readonly source = 'secretcv' as const;
  readonly label = 'Secretcv';
  readonly origin = SECRETCV.origin;
  readonly blockMarkers = SECRETCV.blockMarkers;
  readonly supportsKeywordQuery = false;
  readonly searchPagePath = SECRETCV.searchPagePath;

  searchUrl(target: SearchTarget, _page: number): string {
    return `${this.origin}${SECRETCV.cityPath(citySlug(target.city))}`;
  }

  /** Kullanıcının tarayıcısında anahtar kelimeli arama (şehir süzgeci adreste yok; ilanlar profile aktarılırken süzülür). */
  browserSearchUrl(target: SearchTarget): string {
    return target.keyword ? `${this.origin}${SECRETCV.keywordSearchPath}?${SECRETCV.keywordQuery}=${encodeURIComponent(target.keyword)}` : this.searchUrl(target, 1);
  }

  /** Pozisyon başına bir arama, şehirsiz (arama adresinde şehir süzgeci yok); pozisyon yoksa şehir sayfaları. */
  browserSearches(titles: string[], cities: string[]): BrowserSearch[] {
    if (!titles.length) return super.browserSearches(titles, cities);
    return titles.map((keyword) => ({ cities: [], keywords: [keyword], url: this.browserSearchUrl({ city: cities[0] ?? '', keyword }) }));
  }

  protected parse(html: string, _ctx: PageContext): ParsedPage {
    return parseSecretcvPage(html);
  }

  browserScript(): string {
    return SECRETCV_BROWSER_SCRIPT;
  }

  fromBrowser(payload: unknown, url: string): ParsedPage {
    return secretcvFromBrowser(payload, url);
  }

  /** "/is-ilanlari/istanbul-is-ilanlari" → İstanbul; arama sayfasında ("ara-is-ilanlari") şehir yoktur, anahtar kelime "k". */
  searchOfPage(url: URL): ImportedSearch | null {
    if (url.origin !== this.origin) return null;
    const match = url.pathname.match(SECRETCV.searchPagePath);
    if (!match) return null;
    const city = provinceOfSlug(match[1]);
    return { cities: city ? [city] : [], keyword: url.searchParams.get(SECRETCV.keywordQuery)?.trim() || null };
  }
}
