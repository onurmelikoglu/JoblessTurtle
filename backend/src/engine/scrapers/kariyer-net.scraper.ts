import { findProvince } from '../../domain/provinces';
import { BaseScraper, ImportedSearch } from './base-scraper';
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

  searchUrl(target: SearchTarget, page: number): string {
    return `${this.origin}${KARIYER_NET.cityPath(kariyerCitySlug(target.city), page)}`;
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
   * pozisyon sayfalarında şehir adresten okunamaz.
   */
  searchOfPage(url: URL): ImportedSearch | null {
    if (url.origin !== this.origin) return null;
    const slug = url.pathname.match(KARIYER_NET.searchPagePath)?.[1];
    if (!slug) return null;
    const head = slug.split(/[+-]/)[0];
    const keyword = url.searchParams.get(KARIYER_NET.keywordQuery)?.trim() || null;
    return { city: findProvince((name) => kariyerCitySlug(name) === head), keyword };
  }
}
