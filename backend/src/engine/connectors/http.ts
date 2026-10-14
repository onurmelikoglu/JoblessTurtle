import { sha256 } from '../../common/crypto';
import { env } from '../../common/env';
import { FetchBlockedError, FetchTimeoutError, safeFetch, SafeFetchResponse } from '../../domain/ssrf';
import { ResponseState } from './types';

export interface FetchOutcome {
  state: ResponseState;
  status?: number;
  res?: SafeFetchResponse;
  error?: string;
  retryAfterSeconds?: number | null;
  contentHash?: string;
}

const CHALLENGE = /(captcha|cf-challenge|challenge-platform|verify you are human|robot olmadığınızı)/i;

/**
 * Tüm ilanlarını açıklamalarıyla tek yanıtta veren pano API'leri (Ashby, Recruitee, ilan panoları) için boyut sınırı.
 * Sayfa okumalarındaki genel sınır (FETCH_MAX_BYTES) bu yanıtlar için düşük kalır ve kaynağı "engellendi" gösterir.
 */
export const BOARD_API_MAX_BYTES = 25_000_000;

/** Kaynak isteği: 403/login/CAPTCHA bir erişim durumudur; aşma mekanizması yoktur. */
export async function fetchSource(url: string, headers: Record<string, string> = {}, opts: { maxBytes?: number } = {}): Promise<FetchOutcome> {
  try {
    const res = await safeFetch(url, {
      timeoutMs: env().FETCH_TIMEOUT_MS,
      maxBytes: opts.maxBytes ?? env().FETCH_MAX_BYTES,
      headers,
      allowPrivate: env().ALLOW_PRIVATE_FETCH,
      userAgent: env().HTTP_USER_AGENT,
    });
    const retryAfter = res.headers['retry-after'] ? parseInt(res.headers['retry-after'], 10) : null;
    if (res.status === 304) return { state: 'not_modified', status: 304, res };
    if (res.status === 404 || res.status === 410) return { state: 'not_found', status: res.status, res };
    if (res.status === 401) return { state: 'unauthorized', status: 401, res };
    if (res.status === 403) return { state: CHALLENGE.test(res.text()) ? 'blocked' : 'forbidden', status: 403, res };
    if (res.status === 429) return { state: 'rate_limited', status: 429, res, retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : null };
    if (res.status >= 500) return { state: 'error', status: res.status, res, error: `HTTP ${res.status}` };
    if (res.status >= 400) return { state: 'error', status: res.status, res, error: `HTTP ${res.status}` };
    const text = res.text();
    if (/text\/html/.test(res.headers['content-type'] ?? '') && CHALLENGE.test(text) && text.length < 20000)
      return { state: 'blocked', status: res.status, res, error: 'Güvenlik doğrulaması (CAPTCHA) sayfası' };
    return { state: 'ok', status: res.status, res, contentHash: sha256(res.body) };
  } catch (e) {
    if (e instanceof FetchTimeoutError) return { state: 'timeout', error: e.message };
    if (e instanceof FetchBlockedError) return { state: 'blocked', error: e.message };
    return { state: 'error', error: (e as Error).message };
  }
}

const robotsCache = new Map<string, { at: number; disallow: string[] }>();

/** Basit robots.txt kontrolü (User-agent: * grubundaki Disallow kuralları). */
export async function robotsAllows(url: string): Promise<boolean> {
  const u = new URL(url);
  const key = u.origin;
  let entry = robotsCache.get(key);
  if (!entry || Date.now() - entry.at > 3600_000) {
    const r = await fetchSource(`${u.origin}/robots.txt`);
    const disallow: string[] = [];
    if (r.state === 'ok' && r.res) {
      let applies = false;
      for (const raw of r.res.text().split('\n')) {
        const line = raw.split('#')[0].trim();
        const [k, ...rest] = line.split(':');
        const v = rest.join(':').trim();
        if (/^user-agent$/i.test(k)) applies = v === '*' || /isfirmatakip/i.test(v);
        else if (applies && /^disallow$/i.test(k) && v) disallow.push(v);
      }
    }
    entry = { at: Date.now(), disallow };
    robotsCache.set(key, entry);
  }
  return !entry.disallow.some((d) => u.pathname.startsWith(d));
}
