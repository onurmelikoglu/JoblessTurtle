import * as dns from 'dns';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';

/**
 * SSRF koruması — doküman §16: özel ağ, loopback, link-local/bulut metadata adresleri ve
 * yönlendirme sonrası private IP engellenir; yanıt boyutu ve süre sınırlıdır.
 * IP kontrolü bağlantı anında (lookup kancası) yapılır; DNS rebinding ile atlatılamaz.
 */

export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local + 169.254.169.254 metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 192 && b === 0) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::') return true;
    if (v.startsWith('fc') || v.startsWith('fd')) return true; // ULA
    if (v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb')) return true;
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }
  return true;
}

export class FetchBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FetchBlockedError';
  }
}

export class FetchTimeoutError extends Error {
  constructor() {
    super('İstek zaman aşımına uğradı');
    this.name = 'FetchTimeoutError';
  }
}

export interface SafeFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  headers?: Record<string, string>;
  allowPrivate?: boolean;
  userAgent?: string;
}

export interface SafeFetchResponse {
  status: number;
  url: string;
  headers: Record<string, string>;
  body: Buffer;
  text(): string;
  json<T = any>(): T;
}

export function assertSafeUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new FetchBlockedError('Geçersiz URL');
  }
  if (!['http:', 'https:'].includes(u.protocol)) throw new FetchBlockedError('Yalnızca http/https desteklenir');
  if (u.username || u.password) throw new FetchBlockedError('Kimlik bilgili URL kabul edilmez');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host === 'metadata.google.internal')
    throw new FetchBlockedError('Yerel adreslere istek engellendi');
  if (net.isIP(host) && isPrivateAddress(host)) throw new FetchBlockedError('Özel ağ adresine istek engellendi');
  return u;
}

function guardedLookup(allowPrivate: boolean) {
  return (hostname: string, options: dns.LookupOptions, cb: (...args: any[]) => void) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return cb(err);
      const list = (addresses as unknown as dns.LookupAddress[]) ?? [];
      if (!allowPrivate && list.some((a) => isPrivateAddress(a.address))) {
        return cb(new FetchBlockedError(`Özel ağ adresine çözümlenen alan adı engellendi: ${hostname}`));
      }
      if ((options as any).all) return cb(null, list);
      const first = list[0];
      if (!first) return cb(new Error('DNS sonucu yok'));
      cb(null, first.address, first.family);
    });
  };
}

function requestOnce(u: URL, opts: Required<Pick<SafeFetchOptions, 'timeoutMs' | 'maxBytes'>> & SafeFetchOptions) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(
      u,
      {
        method: 'GET',
        headers: {
          'user-agent': opts.userAgent ?? 'JoblessTurtle/1.1',
          accept: 'text/html,application/json;q=0.9,*/*;q=0.5',
          ...(opts.headers ?? {}),
        },
        lookup: guardedLookup(!!opts.allowPrivate) as any,
        timeout: opts.timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > opts.maxBytes) {
            req.destroy(new FetchBlockedError('Yanıt boyutu sınırı aşıldı'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      },
    );
    const timer = setTimeout(() => req.destroy(new FetchTimeoutError()), opts.timeoutMs);
    req.on('timeout', () => req.destroy(new FetchTimeoutError()));
    req.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    req.on('close', () => clearTimeout(timer));
    req.end();
  });
}

export async function safeFetch(rawUrl: string, options: SafeFetchOptions = {}): Promise<SafeFetchResponse> {
  const opts = { timeoutMs: 15000, maxBytes: 3_000_000, maxRedirects: 5, ...options };
  let url = rawUrl;
  for (let i = 0; i <= opts.maxRedirects; i++) {
    const u = opts.allowPrivate ? new URL(url) : assertSafeUrl(url);
    const res = await requestOnce(u, opts);
    if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.location) {
      url = new URL(String(res.headers.location), u).toString();
      continue;
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(', ') : String(v);
    return {
      status: res.status,
      url,
      headers,
      body: res.body,
      text: () => res.body.toString('utf8'),
      json: () => JSON.parse(res.body.toString('utf8')),
    };
  }
  throw new FetchBlockedError('Çok fazla yönlendirme');
}

const REDIRECT_STATUSES = [301, 302, 303, 307, 308];

/**
 * Yönlendirme zincirini izleyip varılan adresi döndürür; arrived koşulunu sağlayan adrese istek atılmaz. Tıklama
 * sayacı bağlantılarının (ör. posta bültenleri) gerçek hedefini, hedef sayfayı indirmeden öğrenmek içindir.
 * Zincir çözülemezse (hata, yönlendirme yok, sınır aşıldı) o ana kadar varılan adres döner.
 */
export async function resolveRedirects(rawUrl: string, arrived: (url: string) => boolean, options: SafeFetchOptions & { maxHops?: number } = {}): Promise<string> {
  const opts = { timeoutMs: 8000, maxBytes: 300_000, ...options };
  let url = rawUrl;
  for (let hop = 0; hop < (options.maxHops ?? 4) && !arrived(url); hop++) {
    try {
      const u = opts.allowPrivate ? new URL(url) : assertSafeUrl(url);
      const res = await requestOnce(u, opts);
      if (!REDIRECT_STATUSES.includes(res.status) || !res.headers.location) break;
      url = new URL(String(res.headers.location), u).toString();
    } catch {
      break;
    }
  }
  return url;
}
