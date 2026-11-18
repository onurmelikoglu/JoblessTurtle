import * as cheerio from 'cheerio';
import { stripHtml, truncate } from '../../domain/text';
import { parseJobPostingJsonLd } from './career-page';
import { fetchSource, robotsAllows } from './http';

/**
 * İlan sitelerinin liste sayfaları ilan metnini vermez; metin yalnızca ilanın kendi sayfasındadır. Bu modül tek bir ilan
 * sayfasından metni okur: önce JobPosting JSON-LD, sonra sitenin sayfa verisi (Next.js) ve bilinen metin alanları.
 */

const MAX_DESCRIPTION = 8000;

const SMARTRECRUITERS_PAGE = /^https?:\/\/jobs\.smartrecruiters\.com\/([^/?#]+)\/(\d+)/i;
const SMARTRECRUITERS_API = 'https://api.smartrecruiters.com/v1/companies';
const SMARTRECRUITERS_SECTIONS = ['jobDescription', 'qualifications', 'additionalInformation'];

/** JSON-LD vermeyen sitelerde ilan metninin bulunduğu alanlar. */
const SITE_SELECTORS: { host: RegExp; selectors: string[] }[] = [
  { host: /(^|\.)kariyer\.net$/i, selectors: ['.job-detail-container-description', '.job-detail-qualifications'] },
  { host: /(^|\.)linkedin\.com$/i, selectors: ['.show-more-less-html__markup', '.description__text'] },
];

const NUMERIC_ENTITY = /&#(x[0-9a-f]+|\d+);/gi;

function decodeNumericEntities(text: string): string {
  return text.replace(NUMERIC_ENTITY, (_, code: string) => {
    const point = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : parseInt(code, 10);
    return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : ' ';
  });
}

function textOf(html: string): string {
  return decodeNumericEntities(stripHtml(html)).replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').trim();
}

function clean(html: string): string {
  return truncate(textOf(html), MAX_DESCRIPTION) ?? '';
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** Next.js sayfa verisindeki ilan metni (isinolsun gibi siteler metni yalnızca burada taşır). */
function nextDataDescription($: cheerio.CheerioAPI): string {
  const raw = $('script#__NEXT_DATA__').contents().text();
  if (!raw) return '';
  try {
    const job = JSON.parse(raw)?.props?.pageProps?.job;
    return typeof job?.description === 'string' ? clean(job.description) : '';
  } catch {
    return '';
  }
}

function selectorDescription($: cheerio.CheerioAPI, url: string): string {
  const host = hostOf(url);
  const site = SITE_SELECTORS.find((s) => s.host.test(host));
  if (!site) return '';
  for (const selector of site.selectors) {
    const html = $(selector).first().html();
    const text = html ? clean(html) : '';
    if (text) return text;
  }
  return '';
}

/** İlan sayfasının HTML'inden ilan metni; bulunamazsa null. Birden çok aday varsa en uzunu seçilir. */
export function extractListingDescription(html: string, url: string): string | null {
  const $ = cheerio.load(html);
  const candidates = [...parseJobPostingJsonLd(html, url).map((p) => p.description ?? ''), nextDataDescription($), selectorDescription($, url)];
  const best = candidates.map((c) => c.trim()).reduce((a, b) => (b.length > a.length ? b : a), '');
  return best || null;
}

/** SmartRecruiters ilan sayfası, metni Posting API'nin detay ucundan alır (sayfanın kendisi metni betikle yükler). */
export function smartRecruitersDetailUrl(url: string): string | null {
  const m = url.match(SMARTRECRUITERS_PAGE);
  return m ? `${SMARTRECRUITERS_API}/${encodeURIComponent(decodeURIComponent(m[1]))}/postings/${m[2]}` : null;
}

export function parseSmartRecruitersDetail(json: any): string | null {
  const sections = json?.jobAd?.sections ?? {};
  const text = SMARTRECRUITERS_SECTIONS.map((key) => sections[key])
    .filter((s) => s && typeof s.text === 'string' && s.text.trim())
    .map((s) => [s.title, textOf(s.text)].filter(Boolean).join('\n'))
    .join('\n\n');
  return truncate(text.trim(), MAX_DESCRIPTION) || null;
}

/** İlan sayfasını (robots.txt izin veriyorsa) okuyup ilan metnini döner; okunamazsa null. */
export async function fetchListingDescription(url: string): Promise<string | null> {
  const api = smartRecruitersDetailUrl(url);
  if (api) {
    const r = await fetchSource(api);
    if (r.state !== 'ok' || !r.res) return null;
    try {
      return parseSmartRecruitersDetail(r.res.json());
    } catch {
      return null;
    }
  }
  if (!(await robotsAllows(url))) return null;
  const r = await fetchSource(url);
  if (r.state !== 'ok' || !r.res || !/html/.test(r.res.headers['content-type'] ?? '')) return null;
  return extractListingDescription(r.res.text(), url);
}
