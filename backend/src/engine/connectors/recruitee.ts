import { SourceConnector } from '@prisma/client';
import { stripHtml, truncate } from '../../domain/text';
import { BOARD_API_MAX_BYTES, fetchSource } from './http';
import { CollectResult, Connector, RawListing, VerifyResult } from './types';

const BOARD_DOMAIN = 'recruitee.com';
const COMPANY_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const DESCRIPTION_LIMIT = 4000;
const MAX_LOCATIONS = 40;
const LOCATION_SEPARATOR = ' | ';
const REMOTE_LABEL = 'Remote';
const CLOSED_STATUSES = ['closed', 'archived'];
/** Recruitee tarihleri "2026-10-13 10:46:23 UTC" biçiminde verir. */
const UTC_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) UTC$/;

function validDate(value: unknown): Date | null {
  if (!value) return null;
  const d = new Date(typeof value === 'string' ? value.trim().replace(UTC_TIMESTAMP, '$1T$2Z') : (value as number));
  return isNaN(d.getTime()) ? null : d;
}

function place(parts: unknown[]): string {
  return [...new Set(parts.map((p) => (typeof p === 'string' ? p.trim() : '')).filter(Boolean))].join(', ');
}

/** Yer adlarını tekilleştirir; API uzaktan çalışmayı işaretlediyse ve adlarda geçmiyorsa "Remote" ekler. */
function locationLine(places: string[], remote: boolean): string | null {
  const unique = [...new Set(places.filter(Boolean))].slice(0, MAX_LOCATIONS);
  if (remote && !unique.some((p) => /remote/i.test(p))) unique.push(REMOTE_LABEL);
  return unique.join(LOCATION_SEPARATOR) || null;
}

/** Firma kısa adı alan adına girdiği için yalnızca harf, rakam ve tire kabul edilir. */
function boardOrigin(source: SourceConnector): string | null {
  const company = String((source.config as any)?.company ?? '').trim().toLowerCase();
  return COMPANY_PATTERN.test(company) ? `https://${company}.${BOARD_DOMAIN}` : null;
}

export function parseRecruitee(json: any): RawListing[] {
  const offers: any[] = Array.isArray(json?.offers) ? json.offers : [];
  return offers
    .map((o) => {
      const remote = o.remote === true;
      const listed: any[] = Array.isArray(o.locations) ? o.locations : [];
      const places = listed.map((l) => place([l?.city, l?.state, l?.country]) || String(l?.name ?? '').trim());
      if (!places.some(Boolean)) places.push(place([o.city, o.state_name, o.country]) || String(o.location ?? '').trim());
      const body = [o.description, o.requirements].filter((part) => typeof part === 'string' && part).join('\n');
      return {
        externalId: String(o.id ?? '').trim(),
        title: String(o.title ?? '').trim(),
        url: o.careers_url ?? null,
        applyUrl: o.careers_apply_url ?? o.careers_url ?? null,
        locationText: locationLine(places, remote),
        workMode: remote ? 'remote' : o.hybrid === true ? 'hybrid' : o.on_site === true ? 'onsite' : 'unknown',
        description: truncate(stripHtml(body), DESCRIPTION_LIMIT) || null,
        postedAt: validDate(o.published_at) ?? validDate(o.created_at),
        updatedAt: validDate(o.updated_at),
        closedMarker: CLOSED_STATUSES.includes(String(o.status ?? '').toLowerCase()),
      } satisfies RawListing;
    })
    .filter((l) => l.title && l.externalId);
}

/** Recruitee Careers Site API — firma alt alan adı üzerinden kamuya açık ilan listesi. */
export const recruiteeConnector: Connector = {
  kind: 'recruitee',
  label: 'Recruitee',
  extractorVersion: 'recruitee@1',
  capabilities: ['discover', 'detail', 'verify'],
  accessMode: 'api',
  defaultIntervalMinutes: 30,
  minIntervalMinutes: 10,
  applyChannel: 'ats_form',
  isOfficial: true,
  async collect(source: SourceConnector): Promise<CollectResult> {
    const origin = boardOrigin(source);
    if (!origin) return { state: 'error', complete: false, listings: [], pages: 0, sourceUrl: `https://${BOARD_DOMAIN}`, error: 'Kaynak ayarı eksik ya da geçersiz: company' };
    const url = `${origin}/api/offers/`;
    const r = await fetchSource(url, source.etag ? { 'if-none-match': source.etag } : {}, { maxBytes: BOARD_API_MAX_BYTES });
    const base = { sourceUrl: url, pages: 1, httpStatus: r.status, retryAfterSeconds: r.retryAfterSeconds, error: r.error };
    if (r.state === 'not_modified') return { ...base, state: 'not_modified', complete: true, listings: [] };
    if (r.state !== 'ok' || !r.res) return { ...base, state: r.state, complete: false, listings: [] };
    try {
      const listings = parseRecruitee(r.res.json());
      return { ...base, state: 'ok', complete: true, listings, etag: r.res.headers['etag'] ?? null, contentHash: r.contentHash };
    } catch (e) {
      return { ...base, state: 'error', complete: false, listings: [], error: `Ayrıştırma hatası: ${(e as Error).message}` };
    }
  },
  async verify(source: SourceConnector, externalId: string): Promise<VerifyResult> {
    const origin = boardOrigin(source);
    if (!origin) return 'unavailable';
    const r = await fetchSource(`${origin}/api/offers/${encodeURIComponent(externalId)}`);
    if (r.state === 'not_found') return 'not_found';
    if (r.state !== 'ok' || !r.res) return 'unavailable';
    try {
      return CLOSED_STATUSES.includes(String(r.res.json()?.offer?.status ?? '').toLowerCase()) ? 'closed' : 'open';
    } catch {
      return 'unavailable';
    }
  },
};
