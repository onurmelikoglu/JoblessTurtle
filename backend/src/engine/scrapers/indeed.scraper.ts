import { BaseScraper, ImportedSearch } from './base-scraper';
import { INDEED_BROWSER_SCRIPT, indeedFromBrowser } from './parsers/indeed.browser';
import { parseIndeedPage } from './parsers/indeed.parser';
import { INDEED } from './selectors/indeed';
import { PageContext, ParsedPage, SearchTarget } from './types';

/**
 * Indeed Türkiye arama sayfası (/jobs?q=&l=), en yeni ilanlar önce. robots.txt sayfalamaya yalnızca "&start=N&"
 * biçiminde izin verdiği için start parametresinden sonra sıralama parametresi gelir. Oturumsuz kullanıcıya ikinci
 * sayfa gösterilmiyor (giriş sayfasına yönlendirme); varsayılan sayfa sınırı bu yüzden 1'dir.
 */
export class IndeedScraper extends BaseScraper {
  readonly source = 'indeed' as const;
  readonly label = 'Indeed';
  readonly origin = INDEED.origin;
  readonly blockMarkers = INDEED.blockMarkers;
  readonly supportsKeywordQuery = true;

  searchUrl(target: SearchTarget, page: number): string {
    const q = encodeURIComponent(target.keyword ?? '');
    const l = encodeURIComponent(target.city);
    const start = page > 1 ? `&start=${(page - 1) * INDEED.pageSize}` : '';
    return `${this.origin}${INDEED.searchPath}?q=${q}&l=${l}${start}&sort=date`;
  }

  protected parse(html: string, _ctx: PageContext): ParsedPage {
    return parseIndeedPage(html);
  }

  browserScript(): string {
    return INDEED_BROWSER_SCRIPT;
  }

  fromBrowser(payload: unknown, url: string): ParsedPage {
    return indeedFromBrowser(payload, url);
  }

  /** /jobs?q=&l=: şehir "l" parametresinin ilk parçası ("İstanbul, Kadıköy" → "İstanbul"), anahtar kelime "q". */
  searchOfPage(url: URL): ImportedSearch | null {
    if (url.origin !== this.origin || url.pathname.replace(/\/$/, '') !== INDEED.searchPath) return null;
    const city = url.searchParams.get('l')?.split(',')[0].trim() || null;
    return { city, keyword: url.searchParams.get('q')?.trim() || null };
  }
}
