import { SourceConnector } from '@prisma/client';
import { truncate } from '../../domain/text';
import { fetchSource } from './http';
import { CollectResult, Connector, RawListing, VerifyResult } from './types';

const BASE = 'https://api.lever.co/v0/postings';

export function parseLever(json: any): RawListing[] {
  const arr: any[] = Array.isArray(json) ? json : [];
  return arr.map((p) => {
    const loc: string | null = p.categories?.location ?? (Array.isArray(p.categories?.allLocations) ? p.categories.allLocations.join(', ') : null);
    const wt = String(p.workplaceType ?? '').toLowerCase();
    return {
      externalId: String(p.id),
      title: String(p.text ?? '').trim(),
      url: p.hostedUrl ?? null,
      applyUrl: p.applyUrl ?? p.hostedUrl ?? null,
      locationText: loc,
      description: truncate(p.descriptionPlain ?? p.openingPlain ?? '', 4000),
      postedAt: p.createdAt ? new Date(p.createdAt) : null,
      workMode: wt === 'remote' ? 'remote' : wt === 'hybrid' ? 'hybrid' : wt === 'on-site' || wt === 'onsite' ? 'onsite' : 'unknown',
    } satisfies RawListing;
  });
}

/** Lever Postings API — kamuya açık ilan okuma; başvuru varsayılanı hosted form (platformda tamamla). */
export const leverConnector: Connector = {
  kind: 'lever',
  label: 'Lever Postings',
  extractorVersion: 'lever@1',
  capabilities: ['discover', 'detail', 'verify'],
  accessMode: 'api',
  defaultIntervalMinutes: 10,
  minIntervalMinutes: 1,
  applyChannel: 'ats_form',
  isOfficial: true,
  async collect(source: SourceConnector): Promise<CollectResult> {
    const site = (source.config as any)?.site;
    const url = `${BASE}/${encodeURIComponent(site)}?mode=json`;
    const r = await fetchSource(url);
    const base = { sourceUrl: url, pages: 1, httpStatus: r.status, retryAfterSeconds: r.retryAfterSeconds, error: r.error };
    if (r.state !== 'ok' || !r.res) return { ...base, state: r.state, complete: false, listings: [] };
    try {
      return { ...base, state: 'ok', complete: true, listings: parseLever(r.res.json()), contentHash: r.contentHash };
    } catch (e) {
      return { ...base, state: 'error', complete: false, listings: [], error: `Ayrıştırma hatası: ${(e as Error).message}` };
    }
  },
  async verify(source: SourceConnector, externalId: string): Promise<VerifyResult> {
    const site = (source.config as any)?.site;
    const r = await fetchSource(`${BASE}/${encodeURIComponent(site)}/${encodeURIComponent(externalId)}?mode=json`);
    if (r.state === 'ok') return 'open';
    if (r.state === 'not_found') return 'not_found';
    return 'unavailable';
  },
};
