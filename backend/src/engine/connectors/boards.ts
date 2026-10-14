import { SourceConnector } from '@prisma/client';
import { sha256 } from '../../common/crypto';
import { stripHtml, truncate } from '../../domain/text';
import { BOARD_API_MAX_BYTES, fetchSource } from './http';
import { CollectResult, Connector, RawListing, VerifyResult } from './types';

/**
 * Uzaktan çalışma ve yurt dışı ilan panoları (herkese açık API'ler). Bu kaynaklar firmaya bağlı değildir: arama
 * terimleri kaynağın config.terms alanından gelir, gelen ilanlardan yalnızca arama profiline uyanlar kaydedilir.
 * Arama sonucunda görünmemek kapanış sayılmaz (complete her zaman false). Panoların kullanım koşulu gereği ilan
 * bağlantısı panonun kendi sayfasına gider.
 */
const DESCRIPTION_LIMIT = 4000;
const MAX_TERMS = 4;
const REMOTE = 'Remote';
const ARBEITNOW_PAGES = 2;
const HIMALAYAS_PAGE_SIZE = 20;
const REMOTIVE_PAGE_SIZE = 50;

const text = (html: unknown) => truncate(stripHtml(String(html ?? '')), DESCRIPTION_LIMIT);
const dateOf = (value: unknown) => {
  const at = typeof value === 'number' ? new Date(value * 1000) : value ? new Date(String(value)) : null;
  return at && !Number.isNaN(at.getTime()) ? at : null;
};
const remoteLocation = (restriction: string | null | undefined) => (restriction?.trim() ? `${REMOTE} — ${restriction.trim()}` : REMOTE);

export function parseRemotive(json: any): RawListing[] {
  return (Array.isArray(json?.jobs) ? json.jobs : []).map((j: any) => ({
    externalId: String(j.id),
    title: String(j.title ?? '').trim(),
    url: j.url ?? null,
    applyUrl: j.url ?? null,
    locationText: remoteLocation(j.candidate_required_location),
    workMode: 'remote' as const,
    description: text(j.description),
    postedAt: dateOf(j.publication_date),
    companyName: String(j.company_name ?? '').trim() || null,
  }));
}

export function parseRemoteOk(json: any): RawListing[] {
  return (Array.isArray(json) ? json : [])
    .filter((j: any) => j?.id && j.position)
    .map((j: any) => ({
      externalId: String(j.id),
      title: String(j.position).trim(),
      url: j.url ?? null,
      applyUrl: j.apply_url ?? j.url ?? null,
      locationText: remoteLocation(j.location),
      workMode: 'remote' as const,
      description: text(j.description),
      postedAt: dateOf(j.date),
      companyName: String(j.company ?? '').trim() || null,
    }));
}

export function parseHimalayas(json: any): RawListing[] {
  return (Array.isArray(json?.jobs) ? json.jobs : []).map((j: any) => {
    const link: string | null = j.applicationLink ?? j.guid ?? null;
    const restrictions: string[] = Array.isArray(j.locationRestrictions) ? j.locationRestrictions : [];
    return {
      externalId: sha256(String(j.guid ?? link ?? `${j.companyName}|${j.title}`)).slice(0, 24),
      title: String(j.title ?? '').trim(),
      url: link,
      applyUrl: link,
      locationText: remoteLocation(restrictions.join(', ')),
      workMode: 'remote' as const,
      description: text(j.description ?? j.excerpt),
      postedAt: dateOf(j.pubDate),
      validThrough: dateOf(j.expiryDate),
      companyName: String(j.companyName ?? '').trim() || null,
    };
  });
}

/** Arbeitnow ağırlıklı olarak Almanya ve Avrupa ilanlarıdır; konum metni bunu belirtir ki ilan yurt dışı sayılsın. */
export function parseArbeitnow(json: any): RawListing[] {
  return (Array.isArray(json?.data) ? json.data : []).map((j: any) => {
    const place = String(j.location ?? '').trim();
    return {
      externalId: String(j.slug),
      title: String(j.title ?? '').trim(),
      url: j.url ?? null,
      applyUrl: j.url ?? null,
      locationText: j.remote ? remoteLocation(place ? `${place} (Almanya/Avrupa)` : 'Europe') : `${place || 'Belirtilmemiş'} (Almanya/Avrupa)`,
      workMode: j.remote ? ('remote' as const) : ('unknown' as const),
      description: text(j.description),
      postedAt: dateOf(j.created_at),
      companyName: String(j.company_name ?? '').trim() || null,
    };
  });
}

function termsOf(source: SourceConnector): string[] {
  const terms = (source.config as { terms?: unknown } | null)?.terms;
  return (Array.isArray(terms) ? terms : []).map((t) => String(t).trim()).filter(Boolean).slice(0, MAX_TERMS);
}

/** Her adres için bir istek; biri başarısız olursa o ana kadar toplananlar kısmi sonuç olarak döner. */
async function collectFrom(urls: string[], parse: (json: any) => RawListing[]): Promise<CollectResult> {
  const listings = new Map<string, RawListing>();
  let failure: Pick<CollectResult, 'state' | 'httpStatus' | 'error' | 'retryAfterSeconds'> | null = null;
  let pages = 0;
  for (const url of urls) {
    const r = await fetchSource(url, { accept: 'application/json' }, { maxBytes: BOARD_API_MAX_BYTES });
    if (r.state !== 'ok' || !r.res) {
      failure = { state: r.state, httpStatus: r.status, error: r.error, retryAfterSeconds: r.retryAfterSeconds };
      break;
    }
    try {
      for (const listing of parse(r.res.json())) if (listing.title && listing.externalId) listings.set(listing.externalId, listing);
      pages++;
    } catch (e) {
      failure = { state: 'error', error: `Ayrıştırma hatası: ${(e as Error).message}` };
      break;
    }
  }
  const base = { complete: false, listings: [...listings.values()], pages, sourceUrl: urls[0] ?? '' };
  return failure && pages === 0 ? { ...base, ...failure } : { ...base, state: 'ok' };
}

async function verifyByPage(_source: SourceConnector, _externalId: string, url?: string | null): Promise<VerifyResult> {
  if (!url) return 'unavailable';
  const r = await fetchSource(url);
  if (r.state === 'not_found') return 'not_found';
  return r.state === 'ok' ? 'open' : 'unavailable';
}

function board(kind: string, label: string, intervalMinutes: number, urlsFor: (terms: string[]) => string[], parse: (json: any) => RawListing[]): Connector {
  return {
    kind,
    label,
    extractorVersion: `${kind}@1`,
    capabilities: ['discover', 'verify'],
    accessMode: 'api',
    defaultIntervalMinutes: intervalMinutes,
    minIntervalMinutes: intervalMinutes,
    applyChannel: 'ats_form',
    isOfficial: false,
    aggregator: true,
    collect: (source) => collectFrom(urlsFor(termsOf(source)), parse),
    verify: verifyByPage,
  };
}

const HALF_DAY_MINUTES = 12 * 60;
const DAY_MINUTES = 24 * 60;
const q = encodeURIComponent;

/** Remotive günde birkaç istekten fazlasını istemez: günde bir tur, terim başına tek istek. */
export const remotiveConnector = board('remotive', 'Remotive (uzaktan ilanlar)', DAY_MINUTES, (terms) => terms.map((t) => `https://remotive.com/api/remote-jobs?search=${q(t)}&limit=${REMOTIVE_PAGE_SIZE}`), parseRemotive);
export const remoteOkConnector = board('remoteok', 'Remote OK (uzaktan ilanlar)', HALF_DAY_MINUTES, () => ['https://remoteok.com/api'], parseRemoteOk);
export const himalayasConnector = board('himalayas', 'Himalayas (uzaktan ilanlar)', HALF_DAY_MINUTES, (terms) => terms.map((t) => `https://himalayas.app/jobs/api/search?q=${q(t)}&limit=${HIMALAYAS_PAGE_SIZE}`), parseHimalayas);
export const arbeitnowConnector = board(
  'arbeitnow',
  'Arbeitnow (Almanya ve Avrupa ilanları)',
  HALF_DAY_MINUTES,
  () => Array.from({ length: ARBEITNOW_PAGES }, (_, i) => `https://www.arbeitnow.com/api/job-board-api?page=${i + 1}`),
  parseArbeitnow,
);

/** Türkiye'den çalışılabilen uzaktan ilan panoları ve taşınma gerektiren ilan panoları. */
export const REMOTE_BOARDS: Connector[] = [remotiveConnector, remoteOkConnector, himalayasConnector];
export const RELOCATION_BOARDS: Connector[] = [arbeitnowConnector];
export const BOARD_CONNECTORS: Connector[] = [...REMOTE_BOARDS, ...RELOCATION_BOARDS];
