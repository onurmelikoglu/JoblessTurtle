import { SourceConnector } from '@prisma/client';
import * as cheerio from 'cheerio';
import { stripHtml, truncate } from '../../domain/text';
import { fetchSource } from './http';
import { CollectResult, Connector, RawListing, VerifyResult } from './types';

const FEED_PATH = '/xml';
const POSTING_PATH = '/job';
const APPLY_SUFFIX = '/apply';
const FEED_ROOT = /<workzag-jobs[\s>/]/i;
const HOST_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const DESCRIPTION_LIMIT = 4000;
const MAX_LOCATIONS = 40;
const LOCATION_SEPARATOR = ' | ';

function validDate(value: unknown): Date | null {
  if (!value) return null;
  const d = new Date(value as string);
  return isNaN(d.getTime()) ? null : d;
}

/** Ayar tam alan adıdır (acme.jobs.personio.de / .com); şema ve yol yazılmışsa atılır. */
function hostOf(source: SourceConnector): string | null {
  const raw = String((source.config as any)?.host ?? '').trim().toLowerCase();
  const host = raw.replace(/^https?:\/\//, '').split(/[/?#]/)[0];
  return HOST_PATTERN.test(host) ? host : null;
}

function postingUrl(host: string, id: string) {
  return `https://${host}${POSTING_PATH}/${encodeURIComponent(id)}`;
}

/** Akışta ilan adresi yoktur; adresler kariyer sitesinin alan adından (host) üretilir. */
export function parsePersonio(xml: string, host?: string | null): RawListing[] {
  const $ = cheerio.load(xml ?? '', { xmlMode: true });
  const out: RawListing[] = [];
  $('position').each((_, el) => {
    const position = $(el);
    const field = (name: string) => position.children(name).first().text().trim();
    const externalId = field('id');
    const title = field('name');
    if (!title || !externalId) return;
    const offices = [
      field('office'),
      ...position
        .children('additionalOffices')
        .children('office')
        .map((__, office) => $(office).text().trim())
        .get(),
    ];
    const places = [...new Set(offices.filter(Boolean))].slice(0, MAX_LOCATIONS);
    const locationText = places.join(LOCATION_SEPARATOR) || null;
    const sections = position
      .children('jobDescriptions')
      .children('jobDescription')
      .map((__, section) => [$(section).children('name').first().text().trim(), stripHtml($(section).children('value').first().text())].filter(Boolean).join('\n'))
      .get();
    const url = host ? postingUrl(host, externalId) : null;
    out.push({
      externalId,
      title,
      url,
      applyUrl: url ? `${url}${APPLY_SUFFIX}` : null,
      locationText,
      // Akışta çalışma şekli alanı yoktur; yalnızca ofis adı açıkça yazıyorsa işaretlenir.
      workMode: /remote|uzaktan/i.test(locationText ?? '') ? 'remote' : /hybrid|hibrit/i.test(locationText ?? '') ? 'hybrid' : 'unknown',
      description: truncate(sections.filter(Boolean).join('\n'), DESCRIPTION_LIMIT) || null,
      postedAt: validDate(field('createdAt')),
    });
  });
  return out;
}

/** Personio kariyer sitesi XML akışı — firmanın yayındaki ilanları; başvuru Personio formunda tamamlanır. */
export const personioConnector: Connector = {
  kind: 'personio',
  label: 'Personio',
  extractorVersion: 'personio@1',
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
      if (!FEED_ROOT.test(xml)) return { ...base, state: 'error', complete: false, listings: [], error: 'Yanıt bir Personio XML akışı değil' };
      const listings = parsePersonio(xml, host);
      return { ...base, state: 'ok', complete: true, listings, etag: r.res.headers['etag'] ?? null, contentHash: r.contentHash };
    } catch (e) {
      return { ...base, state: 'error', complete: false, listings: [], error: `Ayrıştırma hatası: ${(e as Error).message}` };
    }
  },
  async verify(source: SourceConnector, externalId: string, url?: string | null): Promise<VerifyResult> {
    const host = hostOf(source);
    const target = host ? postingUrl(host, externalId) : url;
    if (!target) return 'unavailable';
    const r = await fetchSource(target);
    if (r.state === 'not_found') return 'not_found';
    if (r.state !== 'ok' || !r.res) return 'unavailable';
    // İlan sayfası başka bir sayfaya yönlendirildiyse yanıt ilanın açık olduğunu göstermez.
    return new URL(r.res.url).pathname.startsWith(`${POSTING_PATH}/${encodeURIComponent(externalId)}`) ? 'open' : 'unavailable';
  },
};
