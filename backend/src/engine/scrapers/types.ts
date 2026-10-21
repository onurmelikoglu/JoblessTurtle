import { RawCard } from '../../domain/scraped-jobs';

/**
 * Tarama hatalarının ayrı türleri; çalışma kaydında ve günlükte birbirinden ayrı tutulur.
 * - blocked: 403, CAPTCHA ya da bot koruması sayfası. Tarama durur; aşmaya çalışılmaz.
 * - rate_limited: 429 ve beklenmesi istenen süre izin verilenden uzun.
 * - robots: robots.txt bu adresi yasaklıyor; istek atılmadı.
 * - selector: sayfa geldi ama beklenen ilan yapısı yok (site düzeni değişmiş olabilir).
 * - parse: sayfa yapısı var ama içerik okunamadı (bozuk gömülü veri, beklenmeyen biçim).
 * - login_required: site sayfayı yalnızca oturum açmış kullanıcıya gösteriyor (giriş sayfasına yönlendirme). Oturum
 *   açılmaz; o aramanın sonraki sayfalarına geçilmez, diğer aramalar sürer.
 * - network: zaman aşımı, bağlantı hatası, 5xx; sınırlı yeniden denemeden sonra.
 */
export type ScrapeErrorKind = 'blocked' | 'rate_limited' | 'robots' | 'login_required' | 'selector' | 'parse' | 'network';

export class ScrapeError extends Error {
  constructor(
    readonly kind: ScrapeErrorKind,
    message: string,
    readonly detail: { url?: string; status?: number; retryAfterSeconds?: number | null } = {},
  ) {
    super(message);
    this.name = 'ScrapeError';
  }
}

/** Taramayı tümüyle durduran hatalar: aynı siteye istek atmaya devam etmek engeli ağırlaştırır. */
export const STOPPING_ERRORS: ScrapeErrorKind[] = ['blocked', 'rate_limited'];

export interface SearchTarget {
  city: string;
  keyword: string | null;
}

export interface ParsedPage {
  cards: RawCard[];
  hasNextPage: boolean;
}

export interface PageContext {
  url: string;
  target: SearchTarget;
  page: number;
}

/** Çalışma kaydındaki hata satırı; "forward" taranan ilanların çalışma alanlarına aktarımındaki hatadır. */
export interface RunError {
  kind: ScrapeErrorKind | 'forward';
  message: string;
  city?: string;
  keyword?: string | null;
  page?: number;
  url?: string;
  status?: number;
  at: string;
}

export interface FetchedPage {
  status: number;
  url: string;
  html: string;
}

/** Ağ katmanı: test ve farklı istemciler için değiştirilebilir. */
export type PageFetcher = (url: string, headers: Record<string, string>) => Promise<{ status: number; url: string; headers: Record<string, string>; text: string }>;
