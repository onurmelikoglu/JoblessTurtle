import { SourceConnector } from '@prisma/client';
import * as cheerio from 'cheerio';
import { stripHtml, truncate } from '../../domain/text';
import { fetchSource } from './http';
import { CollectResult, Connector, RawListing, VerifyResult } from './types';

const FEED_PATH = '/jobs.rss';
const APPLY_PATH = '/applications/new';
const FEED_ROOT = /<rss[\s>]/i;
const HOST_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const POSTING_PATH = /\/jobs\/(\d+)/;
const DESCRIPTION_LIMIT = 4000;
const MAX_LOCATIONS = 40;
const LOCATION_SEPARATOR = ' | ';
const REMOTE_LABEL = 'Remote';
/** remoteStatus değerleri: none (belirtilmemiş), onsite, hybrid, fully (tamamen uzaktan). */
const WORK_MODES = new Map<string, RawListing['workMode']>([
  ['fully', 'remote'],
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

/** Yer adlarını tekilleştirir; akış uzaktan çalışmayı işaretlediyse ve adlarda geçmiyorsa "Remote" ekler. */
function locationLine(places: string[], remote: boolean): string | null {
  const unique = [...new Set(places.filter(Boolean))].slice(0, MAX_LOCATIONS);
  if (remote && !unique.some((p) => /remote/i.test(p))) unique.push(REMOTE_LABEL);
  return unique.join(LOCATION_SEPARATOR) || null;
}

/** Ayar tam alan adıdır (acme.teamtailor.com ya da özel kariyer alan adı); şema ve yol yazılmışsa atılır. */
function hostOf(source: SourceConnector): string | null {
  const raw = String((source.config as any)?.host ?? '').trim().toLowerCase();
  const host = raw.replace(/^https?:\/\//, '').split(/[/?#]/)[0];
  return HOST_PATTERN.test(host) ? host : null;
}

export function parseTeamtailor(xml: string): RawListing[] {
  const $ = cheerio.load(xml ?? '', { xmlMode: true });
  const out: RawListing[] = [];
  $('item').each((_, el) => {
    const item = $(el);
    const field = (name: string) => item.children(name).first().text().trim();
    const title = field('title');
    const link = field('link') || null;
    const externalId = field('guid') || link;
    if (!title || !externalId) return;
    const workMode = WORK_MODES.get(field('remoteStatus').toLowerCase()) ?? 'unknown';
    const places = item
      .find('tt\\:location')
      .map((__, loc) => {
        const part = (name: string) => $(loc).children(name).first().text().trim();
        return place([part('tt\\:city'), part('tt\\:country')]) || part('tt\\:name');
      })
      .get();
    out.push({
      externalId,
      title,
      url: link,
      applyUrl: link ? `${link.replace(/\/+$/, '')}${APPLY_PATH}` : null,
      locationText: locationLine(places, workMode === 'remote'),
      workMode,
      description: truncate(stripHtml(field('description')), DESCRIPTION_LIMIT) || null,
      postedAt: validDate(field('pubDate')),
    });
  });
  return out;
}

/** Teamtailor kariyer sitesi RSS akışı — firmanın yayındaki ilanları; başvuru Teamtailor formunda tamamlanır. */
export const teamtailorConnector: Connector = {
  kind: 'teamtailor',
  label: 'Teamtailor',
  extractorVersion: 'teamtailor@1',
  capabilities: ['discover', 'detail', 'verify'],
  accessMode: 'api',
  defaultIntervalMinutes: 30,
  minIntervalMinutes: 10,
  applyChannel: 'ats_form',
  isOfficial: true,
  async collect(source: SourceConnector): Promise<CollectResult> {
    const host = hostOf(source);
    if (!host) return { state: 'error', complete: false, listings: [], pages: 0, sourceUrl: '', error: 'Kaynak ayarı eksik ya da geçersiz: host' };
    const url = `https://${host}${FEED_PATH}`;
    const r = await fetchSource(url, source.etag ? { 'if-none-match': source.etag } : {});
    const base = { sourceUrl: url, pages: 1, httpStatus: r.status, retryAfterSeconds: r.retryAfterSeconds, error: r.error };
    if (r.state === 'not_modified') return { ...base, state: 'not_modified', complete: true, listings: [] };
    if (r.state !== 'ok' || !r.res) return { ...base, state: r.state, complete: false, listings: [] };
    try {
      const xml = r.res.text();
      // Akış yerine HTML sayfası dönerse boş liste "tüm ilanlar kapandı" diye yorumlanmamalı.
      if (!FEED_ROOT.test(xml)) return { ...base, state: 'error', complete: false, listings: [], error: 'Yanıt bir RSS akışı değil' };
      const listings = parseTeamtailor(xml);
      return { ...base, state: 'ok', complete: true, listings, etag: r.res.headers['etag'] ?? null, lastModified: r.res.headers['last-modified'] ?? null, contentHash: r.contentHash };
    } catch (e) {
      return { ...base, state: 'error', complete: false, listings: [], error: `Ayrıştırma hatası: ${(e as Error).message}` };
    }
  },
  async verify(_source: SourceConnector, _externalId: string, url?: string | null): Promise<VerifyResult> {
    if (!url) return 'unavailable';
    const r = await fetchSource(url);
    if (r.state === 'not_found') return 'not_found';
    if (r.state !== 'ok' || !r.res) return 'unavailable';
    // İlan sayfası başka bir sayfaya yönlendirildiyse yanıt ilanın açık olduğunu göstermez.
    const postingId = POSTING_PATH.exec(url)?.[1];
    return !postingId || POSTING_PATH.exec(r.res.url)?.[1] === postingId ? 'open' : 'unavailable';
  },
};
