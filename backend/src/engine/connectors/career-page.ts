import { SourceConnector } from '@prisma/client';
import * as cheerio from 'cheerio';
import { sha256 } from '../../common/crypto';
import { extractEmails } from '../../domain/contacts';
import { stripHtml, truncate } from '../../domain/text';
import { fetchSource, robotsAllows } from './http';
import { CollectResult, Connector, RawListing, VerifyResult } from './types';

export const CLOSED_TEXT = /(bu ilan kapan|ilan kapanm[ıi]şt[ıi]r|pozisyon kapand|başvurular kapand|no longer accepting|position has been filled|this job is closed|job is no longer available)/i;

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function locationFromJsonLd(jl: any): string | null {
  const parts: string[] = [];
  for (const l of asArray(jl.jobLocation)) {
    const a = l?.address ?? {};
    const s = [a.streetAddress, a.addressLocality, a.addressRegion, a.addressCountry?.name ?? a.addressCountry].filter(Boolean).join(', ');
    if (s) parts.push(s);
  }
  if (jl.jobLocationType === 'TELECOMMUTE') parts.push('Remote');
  return parts.join(' | ') || null;
}

/** Sayfadaki JobPosting JSON-LD kayıtları. JobPosting alanları yalnızca sinyaldir (doküman §4). */
export function parseJobPostingJsonLd(html: string, pageUrl: string): RawListing[] {
  const $ = cheerio.load(html);
  const out: RawListing[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    let data: any;
    try {
      data = JSON.parse($(el).contents().text());
    } catch {
      return;
    }
    const nodes: any[] = [];
    for (const d of asArray(data)) {
      if (d?.['@graph']) nodes.push(...asArray(d['@graph']));
      else nodes.push(d);
    }
    for (const n of nodes) {
      const type = asArray(n?.['@type']).map(String);
      if (!type.includes('JobPosting')) continue;
      const url = n.url ?? pageUrl;
      const id = n.identifier?.value ?? n.identifier ?? url ?? n.title;
      const validThrough = n.validThrough ? new Date(n.validThrough) : null;
      const desc = stripHtml(n.description ?? '');
      out.push({
        externalId: String(typeof id === 'object' ? JSON.stringify(id) : id),
        title: String(n.title ?? '').trim(),
        url,
        locationText: locationFromJsonLd(n),
        description: truncate(desc, 4000),
        postedAt: n.datePosted ? new Date(n.datePosted) : null,
        validThrough: validThrough && !isNaN(validThrough.getTime()) ? validThrough : null,
        closedMarker: CLOSED_TEXT.test(desc),
        requisitionId: n.identifier?.value ? String(n.identifier.value) : null,
        applyEmail: extractEmails(desc)[0] ?? null,
        companyName: n.hiringOrganization?.name ?? null,
        workMode: n.jobLocationType === 'TELECOMMUTE' ? 'remote' : 'unknown',
      });
    }
  });
  return out.filter((l) => l.title);
}

/** config.itemSelector verilmişse basit HTML listesi: her öğenin metni başlık, ilk link detay adresidir. */
export function parseSimpleList(html: string, pageUrl: string, itemSelector: string, locationSelector?: string): RawListing[] {
  const $ = cheerio.load(html);
  const out: RawListing[] = [];
  $(itemSelector).each((_, el) => {
    const node = $(el);
    const link = node.is('a') ? node.attr('href') : node.find('a').first().attr('href');
    const title = (node.find('h1,h2,h3,h4').first().text() || node.text()).replace(/\s+/g, ' ').trim();
    if (!title) return;
    const url = link ? new URL(link, pageUrl).toString() : pageUrl;
    const text = node.text();
    out.push({
      externalId: sha256(url + '|' + title).slice(0, 24),
      title: truncate(title, 200)!,
      url,
      locationText: locationSelector ? node.find(locationSelector).text().trim() || null : null,
      closedMarker: CLOSED_TEXT.test(text),
    });
  });
  return out;
}

/** Firma kariyer sayfası: izinli HTML, JSON-LD JobPosting; robots politikası kontrol edilir. */
export const careerPageConnector: Connector = {
  kind: 'career_page',
  label: 'Firma kariyer sayfası',
  extractorVersion: 'career-page@1',
  capabilities: ['discover', 'detail', 'verify'],
  accessMode: 'html',
  defaultIntervalMinutes: 45,
  minIntervalMinutes: 30,
  applyChannel: 'email',
  isOfficial: true,
  async collect(source: SourceConnector): Promise<CollectResult> {
    const cfg = (source.config ?? {}) as { url?: string; itemSelector?: string; locationSelector?: string };
    const url = cfg.url!;
    const base = { sourceUrl: url, pages: 1 };
    if (!(await robotsAllows(url))) {
      return { ...base, state: 'forbidden', complete: false, listings: [], error: 'robots.txt bu sayfaya erişime izin vermiyor' };
    }
    const r = await fetchSource(url, source.etag ? { 'if-none-match': source.etag } : {});
    if (r.state === 'not_modified') return { ...base, state: 'not_modified', complete: true, listings: [], httpStatus: 304 };
    if (r.state !== 'ok' || !r.res) {
      return { ...base, state: r.state, complete: false, listings: [], httpStatus: r.status, retryAfterSeconds: r.retryAfterSeconds, error: r.error };
    }
    const html = r.res.text();
    let listings = parseJobPostingJsonLd(html, url);
    if (listings.length === 0 && cfg.itemSelector) listings = parseSimpleList(html, url, cfg.itemSelector, cfg.locationSelector);
    const contacts = extractEmails(html).map((email) => ({ email, sourceUrl: url }));
    // JSON-LD ya da seçici yoksa sayfanın eksiksiz listelendiği bilinmez: yokluk kapanış kanıtı olmaz.
    const complete = listings.length > 0 || !!cfg.itemSelector;
    return {
      ...base,
      state: 'ok',
      httpStatus: r.status,
      complete,
      listings,
      contacts,
      etag: r.res.headers['etag'] ?? null,
      lastModified: r.res.headers['last-modified'] ?? null,
      contentHash: r.contentHash,
    };
  },
  async verify(_source: SourceConnector, _externalId: string, url?: string | null): Promise<VerifyResult> {
    if (!url) return 'unavailable';
    const r = await fetchSource(url);
    if (r.state === 'not_found') return 'not_found';
    if (r.state !== 'ok' || !r.res) return 'unavailable';
    const text = r.res.text();
    if (CLOSED_TEXT.test(stripHtml(text))) return 'closed';
    return 'open';
  },
};
