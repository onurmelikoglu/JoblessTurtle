import { SourceConnector } from '@prisma/client';
import { sha256 } from '../../common/crypto';
import { fetchSource } from './http';
import { CollectResult, Connector, RawListing, VerifyResult } from './types';

const API_BASE = 'https://api.smartrecruiters.com/v1/companies';
const PUBLIC_BASE = 'https://jobs.smartrecruiters.com';
const PAGE_SIZE = 100;
const MAX_PAGES = 5;
const LOCATION_SEPARATOR = ' | ';
const REMOTE_LABEL = 'Remote';

function validDate(value: unknown): Date | null {
  if (!value) return null;
  const d = new Date(value as string);
  return isNaN(d.getTime()) ? null : d;
}

function place(parts: unknown[]): string {
  return [...new Set(parts.map((p) => (typeof p === 'string' ? p.trim() : '')).filter(Boolean))].join(', ');
}

function companyOf(source: SourceConnector): string | null {
  const company = (source.config as any)?.company;
  return typeof company === 'string' && company.trim() ? company.trim() : null;
}

function postingsUrl(company: string, offset: number) {
  return `${API_BASE}/${encodeURIComponent(company)}/postings?limit=${PAGE_SIZE}&offset=${offset}`;
}

export function parseSmartRecruiters(json: any): RawListing[] {
  const postings: any[] = Array.isArray(json?.content) ? json.content : [];
  return postings
    .map((p) => {
      const id = String(p.id ?? '').trim();
      const company: string | null = p.company?.identifier ?? null;
      const loc = p.location ?? {};
      const remote = loc.remote === true;
      const where = String(loc.fullLocation ?? '').trim() || place([loc.city, loc.region, typeof loc.country === 'string' ? loc.country.toUpperCase() : null]);
      const places = [where, remote && !/remote/i.test(where) ? REMOTE_LABEL : ''].filter(Boolean);
      // Liste ucu ilan sayfasının adresini vermez; kamuya açık sayfa firma kimliği + ilan numarasıyla açılır.
      const url: string | null = p.postingUrl ?? (company && id ? `${PUBLIC_BASE}/${encodeURIComponent(company)}/${encodeURIComponent(id)}` : null);
      return {
        externalId: id,
        title: String(p.name ?? '').trim(),
        url,
        applyUrl: p.applyUrl ?? url,
        locationText: places.join(LOCATION_SEPARATOR) || null,
        workMode: remote ? 'remote' : loc.hybrid === true ? 'hybrid' : 'unknown',
        postedAt: validDate(p.releasedDate),
        requisitionId: typeof p.refNumber === 'string' && p.refNumber.trim() ? p.refNumber.trim() : null,
      } satisfies RawListing;
    })
    .filter((l) => l.title && l.externalId);
}

/** SmartRecruiters Posting API — firma bazlı kamuya açık ilan listesi; liste ucu ilan metnini içermez. */
export const smartRecruitersConnector: Connector = {
  kind: 'smartrecruiters',
  label: 'SmartRecruiters',
  extractorVersion: 'smartrecruiters@1',
  capabilities: ['discover', 'detail', 'verify'],
  accessMode: 'api',
  defaultIntervalMinutes: 30,
  minIntervalMinutes: 10,
  applyChannel: 'ats_form',
  isOfficial: true,
  async collect(source: SourceConnector): Promise<CollectResult> {
    const company = companyOf(source);
    if (!company) return { state: 'error', complete: false, listings: [], pages: 0, sourceUrl: API_BASE, error: 'Kaynak ayarı eksik: company' };
    const sourceUrl = postingsUrl(company, 0);
    const byId = new Map<string, RawListing>();
    const pageHashes: string[] = [];
    let pages = 0;
    let received = 0;
    let total = 0;
    let httpStatus: number | undefined;
    while (pages < MAX_PAGES) {
      const r = await fetchSource(postingsUrl(company, pages * PAGE_SIZE));
      httpStatus = r.status;
      if (r.state !== 'ok' || !r.res) return { sourceUrl, pages, httpStatus, retryAfterSeconds: r.retryAfterSeconds, error: r.error, state: r.state, complete: false, listings: [] };
      let pageSize: number;
      try {
        const json = r.res.json();
        for (const l of parseSmartRecruiters(json)) byId.set(l.externalId, l);
        pageSize = Array.isArray(json?.content) ? json.content.length : 0;
        total = Number(json?.totalFound) || 0;
      } catch (e) {
        return { sourceUrl, pages, httpStatus, state: 'error', complete: false, listings: [], error: `Ayrıştırma hatası: ${(e as Error).message}` };
      }
      pages++;
      received += pageSize;
      if (r.contentHash) pageHashes.push(r.contentHash);
      if (pageSize === 0 || received >= total) break;
    }
    // Sayfa sınırına takılan taramada görülmeyen ilan kapanmış sayılmaz.
    return { sourceUrl, pages, httpStatus, state: 'ok', complete: received >= total, listings: [...byId.values()], contentHash: sha256(pageHashes.join('|')) };
  },
  async verify(source: SourceConnector, externalId: string): Promise<VerifyResult> {
    const company = companyOf(source);
    if (!company) return 'unavailable';
    const r = await fetchSource(`${API_BASE}/${encodeURIComponent(company)}/postings/${encodeURIComponent(externalId)}`);
    if (r.state === 'not_found') return 'not_found';
    if (r.state !== 'ok' || !r.res) return 'unavailable';
    try {
      return r.res.json()?.active === false ? 'closed' : 'open';
    } catch {
      return 'unavailable';
    }
  },
};
