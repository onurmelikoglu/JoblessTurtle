import { env } from '../../common/env';
import { errorMessage } from '../../common/errors';
import { parseRobots, robotsPathAllowed, RobotsRules } from '../../domain/robots';
import { safeFetch } from '../../domain/ssrf';
import { RateLimiter, realSleep, Sleep } from './rate-limiter';
import { FetchedPage, PageFetcher, ScrapeError } from './types';

export interface HttpClientOptions {
  userAgent: string;
  maxRetries: number;
  retryBaseMs: number;
  maxRetryAfterSeconds: number;
  limiter: RateLimiter;
  blockMarkers: readonly string[];
  fetcher?: PageFetcher;
  sleep?: Sleep;
  random?: () => number;
}

const LOGIN_PATH = /\/(account\/)?(login|signin|sign-in|giris|auth)\b/i;
const ACCEPT_HTML = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8';

/** Sunucu isteği (SSRF korumalı); yönlendirmeler izlenir, varılan adres döner. */
export const defaultFetcher: PageFetcher = async (url, headers) => {
  const res = await safeFetch(url, { timeoutMs: env().FETCH_TIMEOUT_MS, maxBytes: env().FETCH_MAX_BYTES, headers, allowPrivate: env().ALLOW_PRIVATE_FETCH, userAgent: headers['user-agent'] });
  return { status: res.status, url: res.url, headers: res.headers, text: res.text() };
};

/** Retry-After saniye ya da HTTP tarihi olabilir; okunamazsa null. */
export function parseRetryAfter(value: string | undefined, now = Date.now()): number | null {
  const v = value?.trim();
  if (!v) return null;
  if (/^\d+$/.test(v)) return Number(v);
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - now) / 1000));
}

/** Bot koruması işareti (CAPTCHA, doğrulama sayfası) varsa hangisi olduğu. */
export function blockMarkerIn(html: string, markers: readonly string[]): string | null {
  return markers.find((m) => html.includes(m)) ?? null;
}

/**
 * Tarayıcıların tek ağ kapısı: robots.txt'e uyar, istekleri site başına aralıklandırır, geçici hatalarda sınırlı sayıda
 * üstel bekleme ile yeniden dener, 429'da Retry-After'a uyar. 403, CAPTCHA ve giriş duvarında yeniden denemez; hatayı
 * türüyle bildirir. Kendini dürüst bir kullanıcı ajanıyla tanıtır; tarayıcı kimliği taklit edilmez, vekil sunucu yoktur.
 */
export class ScraperHttpClient {
  private readonly robots = new Map<string, RobotsRules | 'unreachable'>();
  private readonly fetcher: PageFetcher;
  private readonly sleep: Sleep;
  private readonly random: () => number;
  requests = 0;

  constructor(private readonly opts: HttpClientOptions) {
    this.fetcher = opts.fetcher ?? defaultFetcher;
    this.sleep = opts.sleep ?? realSleep;
    this.random = opts.random ?? Math.random;
  }

  private headers(): Record<string, string> {
    return { 'user-agent': this.opts.userAgent, accept: ACCEPT_HTML, 'accept-language': 'tr-TR,tr;q=0.9,en;q=0.5' };
  }

  /**
   * robots.txt (RFC 9309): 2xx kurallar okunur; 4xx kısıt yok sayılır; 5xx ya da ağ hatasında site tümüyle yasak sayılır.
   * Kurallar tarama çalışması boyunca bir kez okunur.
   */
  private async robotsRules(origin: string): Promise<RobotsRules | 'unreachable'> {
    const cached = this.robots.get(origin);
    if (cached) return cached;
    let rules: RobotsRules | 'unreachable';
    try {
      await this.opts.limiter.wait();
      this.requests++;
      const res = await this.fetcher(`${origin}/robots.txt`, this.headers());
      if (res.status >= 200 && res.status < 300) rules = parseRobots(res.text, this.opts.userAgent);
      else if (res.status >= 400 && res.status < 500) rules = { allow: [], disallow: [] };
      else rules = 'unreachable';
    } catch {
      rules = 'unreachable';
    }
    this.robots.set(origin, rules);
    return rules;
  }

  async assertAllowed(url: string): Promise<void> {
    const u = new URL(url);
    const rules = await this.robotsRules(u.origin);
    if (rules === 'unreachable') throw new ScrapeError('robots', 'robots.txt okunamadı; site taranmadı', { url });
    if (!robotsPathAllowed(rules, `${u.pathname}${u.search}`)) throw new ScrapeError('robots', `robots.txt bu adresi yasaklıyor: ${u.pathname}${u.search}`, { url });
  }

  private backoffMs(attempt: number): number {
    return this.opts.retryBaseMs * 2 ** attempt + Math.round(this.random() * this.opts.retryBaseMs * 0.5);
  }

  async get(url: string): Promise<FetchedPage> {
    await this.assertAllowed(url);
    const origin = new URL(url).host;
    for (let attempt = 0; ; attempt++) {
      const canRetry = attempt < this.opts.maxRetries;
      await this.opts.limiter.wait();
      this.requests++;
      let res: Awaited<ReturnType<PageFetcher>>;
      try {
        res = await this.fetcher(url, this.headers());
      } catch (e) {
        if (canRetry) {
          await this.sleep(this.backoffMs(attempt));
          continue;
        }
        throw new ScrapeError('network', `Ağ hatası: ${errorMessage(e)}`, { url });
      }
      const marker = blockMarkerIn(res.text, this.opts.blockMarkers);
      const landed = new URL(res.url || url);
      if (landed.host !== origin && LOGIN_PATH.test(landed.pathname)) throw new ScrapeError('login_required', `Sayfa oturum açmayı istiyor (${landed.host}${landed.pathname})`, { url, status: res.status });
      if (res.status === 403 || res.status === 401) throw new ScrapeError('blocked', marker ? `Erişim engellendi: bot koruması (${marker})` : `Erişim engellendi (HTTP ${res.status})`, { url, status: res.status });
      if (res.status === 429) {
        const retryAfter = parseRetryAfter(res.headers['retry-after']);
        if (canRetry && retryAfter !== null && retryAfter <= this.opts.maxRetryAfterSeconds) {
          await this.sleep(retryAfter * 1000);
          continue;
        }
        throw new ScrapeError('rate_limited', retryAfter === null ? 'Çok fazla istek (HTTP 429)' : `Çok fazla istek (HTTP 429); site ${retryAfter} sn beklenmesini istiyor`, { url, status: 429, retryAfterSeconds: retryAfter });
      }
      if (res.status >= 500) {
        if (marker) throw new ScrapeError('blocked', `Erişim engellendi: bot koruması (${marker})`, { url, status: res.status });
        if (canRetry) {
          await this.sleep(this.backoffMs(attempt));
          continue;
        }
        throw new ScrapeError('network', `Sunucu hatası (HTTP ${res.status})`, { url, status: res.status });
      }
      if (res.status === 404 || res.status === 410) throw new ScrapeError('selector', `Arama sayfası bulunamadı (HTTP ${res.status}); adres kalıbı ya da şehir adı geçersiz olabilir`, { url, status: res.status });
      if (res.status >= 400) throw new ScrapeError('network', `Beklenmeyen yanıt (HTTP ${res.status})`, { url, status: res.status });
      return { status: res.status, url: res.url || url, html: res.text };
    }
  }
}
