import { errorMessage } from '../../common/errors';
import { CardRejection, isRejection, matchesKeywords, normalizeCard, ScrapedListing } from '../../domain/scraped-jobs';
import { KEYWORD_MODES, ScraperSource } from '../../domain/scraper-config';
import { blockMarkerIn, ScraperHttpClient } from './http-client';
import { runPool } from './rate-limiter';
import { FetchedPage, PageContext, ParsedPage, ScrapeError, SearchTarget } from './types';

export type KeywordMode = (typeof KEYWORD_MODES)[number];

export interface CollectOptions {
  cities: string[];
  keywords: string[];
  keywordMode: KeywordMode;
  maxPages: number;
  concurrency: number;
  now: Date;
}

/** Tarama döngüsünün dışarıya bildirdikleri; kayıt, sayaçlar ve durdurma kararı çalışmayı yöneten serviste. */
export interface CollectHooks {
  pageDone(listings: ScrapedListing[], ctx: PageContext, cardCount: number): Promise<void>;
  pageFailed(error: ScrapeError, ctx: PageContext): void;
  cardRejected(reason: CardRejection, ctx: PageContext): void;
  stopped(): boolean;
}

/**
 * Ortak tarayıcı: arama hedeflerini (şehir × anahtar kelime) çıkarır, sayfaları sırayla dolaşır, kartları standart modele
 * çevirir. Yeni bir site eklemek için yalnızca arama adresi, ayrıştırıcı ve bot koruması işaretleri yazılır.
 */
export abstract class BaseScraper {
  abstract readonly source: ScraperSource;
  abstract readonly label: string;
  abstract readonly origin: string;
  abstract readonly blockMarkers: readonly string[];
  /** Site anahtar kelimeyi arama adresinde destekliyor mu (doğrulanmış biçim)? Desteklemiyorsa ilanlar yerelde süzülür. */
  abstract readonly supportsKeywordQuery: boolean;

  abstract searchUrl(target: SearchTarget, page: number): string;
  protected abstract parse(html: string, ctx: PageContext): ParsedPage;

  keywordModeOf(configured: KeywordMode): KeywordMode {
    return this.supportsKeywordQuery ? configured : 'local_filter';
  }

  targets(cities: string[], keywords: string[], mode: KeywordMode): SearchTarget[] {
    if (mode === 'query' && keywords.length) return cities.flatMap((city) => keywords.map((keyword) => ({ city, keyword })));
    return cities.map((city) => ({ city, keyword: null }));
  }

  /**
   * Sayfa geldi ama ilan yapısı yoksa ya da hiç kart yoksa önce bot koruması işaretine bakılır: doğrulama sayfası
   * "selector" değil "blocked" sayılır. Normal sayfalarda da "captcha" sözcüğü geçebildiği için yalnızca yapı yokken bakılır.
   */
  parsePage(page: FetchedPage, ctx: PageContext): ParsedPage {
    const blocked = () => {
      const marker = blockMarkerIn(page.html, this.blockMarkers);
      return marker ? new ScrapeError('blocked', `Erişim engellendi: bot koruması (${marker})`, { url: ctx.url, status: page.status }) : null;
    };
    let parsed: ParsedPage;
    try {
      parsed = this.parse(page.html, ctx);
    } catch (e) {
      throw blocked() ?? (e instanceof ScrapeError ? e : new ScrapeError('parse', errorMessage(e), { url: ctx.url }));
    }
    if (!parsed.cards.length) {
      const block = blocked();
      if (block) throw block;
    }
    return parsed;
  }

  async collect(client: ScraperHttpClient, opts: CollectOptions, hooks: CollectHooks): Promise<void> {
    const mode = this.keywordModeOf(opts.keywordMode);
    await runPool(this.targets(opts.cities, opts.keywords, mode), opts.concurrency, (target) => this.collectTarget(client, target, { ...opts, keywordMode: mode }, hooks), hooks.stopped);
  }

  /** Bir aramanın sayfaları: sayfa alınamazsa o arama biter (sonraki sayfa bilinemez); yeni ilan çıkmayan sayfada durulur. */
  private async collectTarget(client: ScraperHttpClient, target: SearchTarget, opts: CollectOptions, hooks: CollectHooks): Promise<void> {
    const seen = new Set<string>();
    for (let page = 1; page <= opts.maxPages && !hooks.stopped(); page++) {
      const ctx: PageContext = { url: this.searchUrl(target, page), target, page };
      let parsed: ParsedPage;
      try {
        parsed = this.parsePage(await client.get(ctx.url), ctx);
      } catch (e) {
        hooks.pageFailed(e instanceof ScrapeError ? e : new ScrapeError('parse', errorMessage(e), { url: ctx.url }), ctx);
        return;
      }
      const listings: ScrapedListing[] = [];
      let valid = 0;
      let unseen = 0;
      for (const card of parsed.cards) {
        const listing = normalizeCard(this.source, card, { origin: this.origin, searchedCity: target.city, now: opts.now });
        if (isRejection(listing)) {
          hooks.cardRejected(listing, ctx);
          continue;
        }
        valid++;
        if (!seen.has(listing.externalId)) {
          seen.add(listing.externalId);
          unseen++;
        }
        if (opts.keywordMode === 'local_filter' && !matchesKeywords(listing, opts.keywords)) continue;
        listings.push(listing);
      }
      if (parsed.cards.length && !valid) {
        hooks.pageFailed(new ScrapeError('selector', `${parsed.cards.length} kartın hiçbirinden firma, unvan, şehir ve bağlantı birlikte okunamadı; kart düzeni değişmiş olabilir`, { url: ctx.url }), ctx);
        return;
      }
      await hooks.pageDone(listings, ctx, parsed.cards.length);
      if (!parsed.hasNextPage || !unseen) return;
    }
  }
}
