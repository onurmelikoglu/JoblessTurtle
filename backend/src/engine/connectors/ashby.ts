import { SourceConnector } from '@prisma/client';
import { stripHtml, truncate } from '../../domain/text';
import { BOARD_API_MAX_BYTES, fetchSource } from './http';
import { CollectResult, Connector, RawListing, VerifyResult } from './types';

const BASE = 'https://api.ashbyhq.com/posting-api/job-board';
const DESCRIPTION_LIMIT = 4000;
const MAX_LOCATIONS = 40;
const LOCATION_SEPARATOR = ' | ';
const REMOTE_LABEL = 'Remote';
const WORK_MODES = new Map<string, RawListing['workMode']>([
  ['remote', 'remote'],
  ['hybrid', 'hybrid'],
  ['onsite', 'onsite'],
]);

function validDate(value: unknown): Date | null {
  if (!value) return null;
  const d = new Date(value as string);
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

function placeOf(entry: any): string {
  const address = entry?.address?.postalAddress ?? {};
  return String(entry?.location ?? '').trim() || place([address.addressLocality, address.addressRegion, address.addressCountry]);
}

function orgOf(source: SourceConnector): string | null {
  const org = (source.config as any)?.org;
  return typeof org === 'string' && org.trim() ? org.trim() : null;
}

function jobsOf(json: any): any[] {
  return Array.isArray(json?.jobs) ? json.jobs : [];
}

export function parseAshby(json: any): RawListing[] {
  return jobsOf(json)
    .map((j) => {
      // Ashby hibrit ilanlarda da isRemote=true gönderir; belirleyici alan workplaceType'tır.
      const workMode = WORK_MODES.get(String(j.workplaceType ?? '').toLowerCase()) ?? (j.isRemote === true ? 'remote' : 'unknown');
      const secondary: any[] = Array.isArray(j.secondaryLocations) ? j.secondaryLocations : [];
      return {
        externalId: String(j.id ?? '').trim(),
        title: String(j.title ?? '').trim(),
        url: j.jobUrl ?? null,
        applyUrl: j.applyUrl ?? j.jobUrl ?? null,
        locationText: locationLine([placeOf(j), ...secondary.map(placeOf)], workMode === 'remote'),
        workMode,
        description: truncate(String(j.descriptionPlain ?? '').trim() || stripHtml(j.descriptionHtml ?? ''), DESCRIPTION_LIMIT) || null,
        postedAt: validDate(j.publishedAt),
        closedMarker: j.isListed === false,
      } satisfies RawListing;
    })
    .filter((l) => l.title && l.externalId);
}

/** Ashby Job Postings API — kurum panosunun kamuya açık ilanları tek yanıtta gelir; ilan başına ayrı uç yoktur. */
export const ashbyConnector: Connector = {
  kind: 'ashby',
  label: 'Ashby',
  extractorVersion: 'ashby@1',
  capabilities: ['discover', 'detail', 'verify'],
  accessMode: 'api',
  defaultIntervalMinutes: 30,
  minIntervalMinutes: 10,
  applyChannel: 'ats_form',
  isOfficial: true,
  async collect(source: SourceConnector): Promise<CollectResult> {
    const org = orgOf(source);
    if (!org) return { state: 'error', complete: false, listings: [], pages: 0, sourceUrl: BASE, error: 'Kaynak ayarı eksik: org' };
    const url = `${BASE}/${encodeURIComponent(org)}`;
    const r = await fetchSource(url, source.etag ? { 'if-none-match': source.etag } : {}, { maxBytes: BOARD_API_MAX_BYTES });
    const base = { sourceUrl: url, pages: 1, httpStatus: r.status, retryAfterSeconds: r.retryAfterSeconds, error: r.error };
    if (r.state === 'not_modified') return { ...base, state: 'not_modified', complete: true, listings: [] };
    if (r.state !== 'ok' || !r.res) return { ...base, state: r.state, complete: false, listings: [] };
    try {
      const listings = parseAshby(r.res.json());
      return { ...base, state: 'ok', complete: true, listings, etag: r.res.headers['etag'] ?? null, contentHash: r.contentHash };
    } catch (e) {
      return { ...base, state: 'error', complete: false, listings: [], error: `Ayrıştırma hatası: ${(e as Error).message}` };
    }
  },
  /** İlan sayfası olmayan ilanda da 200 döndüğü için doğrulama pano yanıtındaki kayıt üzerinden yapılır. */
  async verify(source: SourceConnector, externalId: string): Promise<VerifyResult> {
    const org = orgOf(source);
    if (!org) return 'unavailable';
    const r = await fetchSource(`${BASE}/${encodeURIComponent(org)}`, {}, { maxBytes: BOARD_API_MAX_BYTES });
    if (r.state === 'not_found') return 'not_found';
    if (r.state !== 'ok' || !r.res) return 'unavailable';
    try {
      const job = jobsOf(r.res.json()).find((j) => String(j?.id) === externalId);
      if (!job) return 'not_found';
      return job.isListed === false ? 'closed' : 'open';
    } catch {
      return 'unavailable';
    }
  },
};
