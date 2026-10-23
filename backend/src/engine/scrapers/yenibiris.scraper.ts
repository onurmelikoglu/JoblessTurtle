import { citySlug, provinceOfSlug } from '../../domain/provinces';
import { BaseScraper, ImportedSearch } from './base-scraper';
import { YENIBIRIS_BROWSER_SCRIPT, yenibirisFromBrowser } from './parsers/yenibiris.browser';
import { parseYenibirisPage } from './parsers/yenibiris.parser';
import { YENIBIRIS } from './selectors/yenibiris';
import { PageContext, ParsedPage, SearchTarget } from './types';

/**
 * Yenibiriş: yalnızca eklentiyle. Site sunucudan gelen her isteği Cloudflare ile geri çevirdiği için sunucu taraması
 * açılmaz; arama adresi (/is-ilanlari/<şehir>?q=…) kullanıcının tarayıcısında açılır.
 */
export class YenibirisScraper extends BaseScraper {
  readonly source = 'yenibiris' as const;
  readonly label = 'Yenibiriş';
  readonly origin = YENIBIRIS.origin;
  readonly blockMarkers = YENIBIRIS.blockMarkers;
  readonly supportsKeywordQuery = true;
  readonly searchPagePath = YENIBIRIS.searchPagePath;
  readonly serverScraping = false;

  searchUrl(target: SearchTarget, page: number): string {
    const params = new URLSearchParams();
    if (target.keyword) params.set(YENIBIRIS.keywordQuery, target.keyword);
    if (page > 1) params.set(YENIBIRIS.pageQuery, String(page));
    const query = params.toString();
    return `${this.origin}${YENIBIRIS.cityPath(citySlug(target.city))}${query ? `?${query}` : ''}`;
  }

  protected parse(html: string, ctx: PageContext): ParsedPage {
    return parseYenibirisPage(html, { page: ctx.page });
  }

  browserScript(): string {
    return YENIBIRIS_BROWSER_SCRIPT;
  }

  fromBrowser(payload: unknown, url: string): ParsedPage {
    return yenibirisFromBrowser(payload, url);
  }

  searchOfPage(url: URL): ImportedSearch | null {
    if (url.origin !== this.origin) return null;
    const match = url.pathname.match(YENIBIRIS.searchPagePath);
    if (!match) return null;
    const city = provinceOfSlug(match[1]);
    return { cities: city ? [city] : [], keyword: url.searchParams.get(YENIBIRIS.keywordQuery)?.trim() || null };
  }
}
