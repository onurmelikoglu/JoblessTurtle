import { SourceConnector } from '@prisma/client';
import { stripHtml, truncate } from '../../domain/text';
import { fetchSource } from './http';
import { CollectResult, Connector, RawListing, VerifyResult } from './types';

const WIDGET_BASE = 'https://apply.workable.com/api/v1/widget/accounts';
const DETAIL_BASE = 'https://apply.workable.com/api/v2/accounts';
const POSTING_BASE = 'https://apply.workable.com/j';
const DESCRIPTION_LIMIT = 4000;
const MAX_LOCATIONS = 40;
const LOCATION_SEPARATOR = ' | ';
const REMOTE_LABEL = 'Remote';
const CLOSED_STATES = ['closed', 'archived'];

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

function accountOf(source: SourceConnector): string | null {
  const account = (source.config as any)?.account;
  return typeof account === 'string' && account.trim() ? account.trim() : null;
}

export function parseWorkable(json: any): RawListing[] {
  const jobs: any[] = Array.isArray(json?.jobs) ? json.jobs : [];
  return jobs
    .map((j) => {
      const shortcode = String(j.shortcode ?? '').trim();
      const remote = j.telecommuting === true;
      const listed: any[] = Array.isArray(j.locations) ? j.locations : [];
      const places = listed.length ? listed.map((l) => place([l?.city, l?.region, l?.country])) : [place([j.city, j.state, j.country])];
      const url: string | null = j.url ?? j.shortlink ?? (shortcode ? `${POSTING_BASE}/${shortcode}` : null);
      return {
        externalId: shortcode,
        title: String(j.title ?? '').trim(),
        url,
        applyUrl: j.application_url ?? url,
        locationText: locationLine(places, remote),
        // Widget yalnızca "telecommuting" bayrağını verir; hibrit/ofis ayrımı bu uçta yoktur.
        workMode: remote ? 'remote' : 'unknown',
        description: truncate(stripHtml(j.description ?? ''), DESCRIPTION_LIMIT) || null,
        postedAt: validDate(j.published_on) ?? validDate(j.created_at),
        requisitionId: typeof j.code === 'string' && j.code.trim() ? j.code.trim() : null,
      } satisfies RawListing;
    })
    .filter((l) => l.title && l.externalId);
}

/** Workable kariyer widget API'si — hesap bazlı kamuya açık ilan listesi; başvuru Workable formunda tamamlanır. */
export const workableConnector: Connector = {
  kind: 'workable',
  label: 'Workable',
  extractorVersion: 'workable@1',
  capabilities: ['discover', 'detail', 'verify'],
  accessMode: 'api',
  defaultIntervalMinutes: 30,
  minIntervalMinutes: 10,
  applyChannel: 'ats_form',
  isOfficial: true,
  async collect(source: SourceConnector): Promise<CollectResult> {
    const account = accountOf(source);
    if (!account) return { state: 'error', complete: false, listings: [], pages: 0, sourceUrl: WIDGET_BASE, error: 'Kaynak ayarı eksik: account' };
    const url = `${WIDGET_BASE}/${encodeURIComponent(account)}?details=true`;
    const r = await fetchSource(url, source.etag ? { 'if-none-match': source.etag } : {});
    const base = { sourceUrl: url, pages: 1, httpStatus: r.status, retryAfterSeconds: r.retryAfterSeconds, error: r.error };
    if (r.state === 'not_modified') return { ...base, state: 'not_modified', complete: true, listings: [] };
    if (r.state !== 'ok' || !r.res) return { ...base, state: r.state, complete: false, listings: [] };
    try {
      const listings = parseWorkable(r.res.json());
      return { ...base, state: 'ok', complete: true, listings, etag: r.res.headers['etag'] ?? null, contentHash: r.contentHash };
    } catch (e) {
      return { ...base, state: 'error', complete: false, listings: [], error: `Ayrıştırma hatası: ${(e as Error).message}` };
    }
  },
  async verify(source: SourceConnector, externalId: string): Promise<VerifyResult> {
    const account = accountOf(source);
    if (!account) return 'unavailable';
    const r = await fetchSource(`${DETAIL_BASE}/${encodeURIComponent(account)}/jobs/${encodeURIComponent(externalId)}`);
    if (r.state === 'not_found') return 'not_found';
    if (r.state !== 'ok' || !r.res) return 'unavailable';
    try {
      return CLOSED_STATES.includes(String(r.res.json()?.state ?? '').toLowerCase()) ? 'closed' : 'open';
    } catch {
      return 'unavailable';
    }
  },
};
