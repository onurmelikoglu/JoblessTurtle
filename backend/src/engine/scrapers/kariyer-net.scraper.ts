import { BaseScraper } from './base-scraper';
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
}
