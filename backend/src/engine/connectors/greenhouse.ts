import { SourceConnector } from '@prisma/client';
import { stripHtml, truncate } from '../../domain/text';
import { fetchSource } from './http';
import { CollectResult, Connector, RawListing, VerifyResult } from './types';

const BASE = 'https://boards-api.greenhouse.io/v1/boards';

function decodeEntities(s: string) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

export function parseGreenhouse(json: any): RawListing[] {
  const jobs: any[] = Array.isArray(json?.jobs) ? json.jobs : [];
  return jobs.map((j) => {
    const loc: string | null = j.location?.name ?? null;
    return {
      externalId: String(j.id),
      title: String(j.title ?? '').trim(),
      url: j.absolute_url ?? null,
      locationText: loc,
      description: truncate(stripHtml(decodeEntities(j.content ?? '')), 4000),
      updatedAt: j.updated_at ? new Date(j.updated_at) : null,
      postedAt: j.first_published ? new Date(j.first_published) : null,
      requisitionId: j.requisition_id ?? j.internal_job_id?.toString() ?? null,
      applyUrl: j.absolute_url ?? null,
      workMode: /remote|uzaktan/i.test(loc ?? '') ? 'remote' : /hybrid|hibrit/i.test(loc ?? '') ? 'hybrid' : 'unknown',
    } satisfies RawListing;
  });
}

/** Greenhouse Job Board API — firma bazlı kamuya açık ilan okuma. Gönderim işveren anahtarı ister (MVP'de yok). */
export const greenhouseConnector: Connector = {
  kind: 'greenhouse',
  label: 'Greenhouse Job Board',
  extractorVersion: 'greenhouse@1',
  capabilities: ['discover', 'detail', 'verify'],
  accessMode: 'api',
  defaultIntervalMinutes: 10,
  minIntervalMinutes: 1,
  applyChannel: 'ats_form',
  isOfficial: true,
  async collect(source: SourceConnector): Promise<CollectResult> {
    const board = (source.config as any)?.boardToken;
    const url = `${BASE}/${encodeURIComponent(board)}/jobs?content=true`;
    const r = await fetchSource(url, source.etag ? { 'if-none-match': source.etag } : {});
    const base = { sourceUrl: url, pages: 1, httpStatus: r.status, retryAfterSeconds: r.retryAfterSeconds, error: r.error };
    if (r.state !== 'ok' || !r.res) return { ...base, state: r.state, complete: false, listings: [] };
    try {
      const listings = parseGreenhouse(r.res.json());
      return { ...base, state: 'ok', complete: true, listings, etag: r.res.headers['etag'] ?? null, contentHash: r.contentHash };
    } catch (e) {
      return { ...base, state: 'error', complete: false, listings: [], error: `Ayrıştırma hatası: ${(e as Error).message}` };
    }
  },
  async verify(source: SourceConnector, externalId: string): Promise<VerifyResult> {
    const board = (source.config as any)?.boardToken;
    const r = await fetchSource(`${BASE}/${encodeURIComponent(board)}/jobs/${encodeURIComponent(externalId)}`);
    if (r.state === 'ok') return 'open';
    if (r.state === 'not_found') return 'not_found';
    return 'unavailable';
  },
};
