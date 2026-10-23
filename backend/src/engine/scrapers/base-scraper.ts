import { errorMessage } from '../../common/errors';
import { CardRejection, isRejection, matchesKeywords, normalizeCard, ScrapedListing } from '../../domain/scraped-jobs';
import { KEYWORD_MODES, ScraperSource } from '../../domain/scraper-config';
import { blockMarkerIn, ScraperHttpClient } from './http-client';
import { runPool } from './rate-limiter';
import { FetchedPage, PageContext, ParsedPage, ScrapeError, SearchTarget } from './types';

export type KeywordMode = (typeof KEYWORD_MODES)[number];

/** Eklentiden gelen sayfanın araması; şehir adreste yoksa (pozisyon sayfası gibi) null. */
export interface ImportedSearch {
  city: string | null;
  keyword: string | null;
}

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

  /** Sayfanın kartları standart ilana çevrilir; zorunlu alanı eksik kart uydurulmaz, yerel anahtar kelime süzgeci uygulanır. */
  listingsOf(parsed: ParsedPage, searchedCity: string | null, opts: Pick<CollectOptions, 'keywordMode' | 'keywords' | 'now'>, onReject: (reason: CardRejection) => void) {
    const listings: ScrapedListing[] = [];
    const ids: string[] = [];
    let valid = 0;
    for (const card of parsed.cards) {
      const listing = normalizeCard(this.source, card, { origin: this.origin, searchedCity, now: opts.now });
      if (isRejection(listing)) {
        onReject(listing);
        continue;
      }
      valid++;
      ids.push(listing.externalId);
      if (opts.keywordMode === 'local_filter' && !matchesKeywords(listing, opts.keywords)) continue;
      listings.push(listing);
    }
    return { listings, valid, ids };
  }

  unreadableCards(count: number, url: string): ScrapeError {
    return new ScrapeError('selector', `${count} kartın hiçbirinden firma, unvan, şehir ve bağlantı birlikte okunamadı; kart düzeni değişmiş olabilir`, { url });
  }

  /**
   * Kullanıcının tarayıcısında (Jobless Turtle eklentisi) çalışan okuma betiği: kullanıcının açtığı sayfadaki kartları,
   * sonraki sayfa bilgisini ve doğrulama sayfası işaretini "JT_PAGE {…}" metni olarak döndürür. Betik siteye istek atmaz,
   * gezinmez, tıklamaz, yazmaz.
   */
  abstract browserScript(): string;

  /** Betiğin döndürdüğü veriyi sunucudaki kart biçimine çevirir; doğrulama sayfasıysa "blocked", yapı yoksa "selector" hatası. */
  abstract fromBrowser(payload: unknown, url: string): ParsedPage;

  /**
   * Eklentinin gönderdiği adres bu sitenin arama sonuç sayfası mı? Öyleyse aranan şehir ve anahtar kelime (adresten
   * okunabildiği kadar), değilse null. Başka bir adresten gelen veri kaydedilmez.
   */
  abstract searchOfPage(url: URL): ImportedSearch | null;

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
      const { listings, valid, ids } = this.listingsOf(parsed, target.city, opts, (reason) => hooks.cardRejected(reason, ctx));
      const unseen = ids.filter((id) => !seen.has(id));
      unseen.forEach((id) => seen.add(id));
      if (parsed.cards.length && !valid) {
        hooks.pageFailed(this.unreadableCards(parsed.cards.length, ctx.url), ctx);
        return;
      }
      await hooks.pageDone(listings, ctx, parsed.cards.length);
      if (!parsed.hasNextPage || !unseen.length) return;
    }
  }
}
