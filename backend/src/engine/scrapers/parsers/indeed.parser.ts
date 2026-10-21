import * as cheerio from 'cheerio';
import { provinceByPlate } from '../../../domain/provinces';
import { RawCard } from '../../../domain/scraped-jobs';
import { fold, stripHtml } from '../../../domain/text';
import { INDEED } from '../selectors/indeed';
import { ParsedPage, ScrapeError } from '../types';

interface IndeedResult {
  jobkey?: string;
  title?: string;
  displayTitle?: string;
  company?: string;
  formattedLocation?: string;
  jobLocationCity?: string;
  jobLocationState?: string;
  remoteLocation?: boolean;
  jobTypes?: string[];
  pubDate?: number;
  formattedRelativeTime?: string;
  snippet?: string;
  companyOverviewLink?: string;
}

/** Atamadan sonra başlayan JSON nesnesini (dizgi içindeki parantezleri sayamadan) ayıklar. */
export function extractJsonObject(source: string, start: number): string | null {
  const open = source.indexOf('{', start);
  if (open < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return null;
}

/**
 * Konum il plaka koduyla ("T34") gelir; konum metni ilin kendisi değilse ilçedir. İl çözülemezse metin olduğu gibi
 * kalır ve şehir/ilçe ayrımı ortak normalizasyona bırakılır.
 */
export function indeedLocation(result: Pick<IndeedResult, 'formattedLocation' | 'jobLocationCity' | 'jobLocationState'>): string | null {
  const text = (result.formattedLocation ?? result.jobLocationCity ?? '').trim();
  const plate = result.jobLocationState?.match(/^T(\d{1,2})$/)?.[1];
  const province = plate ? provinceByPlate(Number(plate)) : null;
  if (!province) return text || null;
  if (!text || fold(text) === fold(province)) return province;
  return `${province} - ${text}`;
}

function fromResult(r: IndeedResult): RawCard {
  const at = typeof r.pubDate === 'number' && r.pubDate > 0 ? new Date(r.pubDate) : null;
  return {
    platformId: r.jobkey ?? null,
    title: r.displayTitle ?? r.title ?? null,
    company: r.company ?? null,
    location: indeedLocation(r),
    url: r.jobkey ? INDEED.viewJobPath(r.jobkey) : null,
    companyUrl: r.companyOverviewLink ?? null,
    description: r.snippet ? stripHtml(r.snippet) : null,
    employmentType: r.jobTypes?.length ? r.jobTypes.join(', ') : null,
    workModeText: r.remoteLocation ? 'Uzaktan' : null,
    publishedAt: at && !Number.isNaN(at.getTime()) ? at : null,
    publishedText: r.formattedRelativeTime ?? null,
  };
}

function embeddedResults(html: string): IndeedResult[] | null {
  const at = html.indexOf(INDEED.embeddedData);
  if (at < 0) return null;
  const json = extractJsonObject(html, at + INDEED.embeddedData.length);
  if (!json) throw new ScrapeError('parse', 'Gömülü ilan verisi (mosaic-provider-jobcards) kapanmamış');
  let data: any;
  try {
    data = JSON.parse(json);
  } catch (e) {
    throw new ScrapeError('parse', `Gömülü ilan verisi okunamadı: ${(e as Error).message}`);
  }
  const results = data?.metaData?.mosaicProviderJobCardsModel?.results;
  if (!Array.isArray(results)) throw new ScrapeError('parse', 'Gömülü ilan verisinde results dizisi yok');
  return results as IndeedResult[];
}

function domCards(html: string): RawCard[] {
  const $ = cheerio.load(html);
  const s = INDEED.selectors;
  return $(s.card)
    .toArray()
    .map((el) => {
      const link = $(el);
      const root = link.closest(s.cardRoot);
      const jobKey = link.attr('data-jk') ?? null;
      return {
        platformId: jobKey,
        title: link.find(s.title).first().text().trim() || link.text().trim() || null,
        company: root.find(s.company).first().text().trim() || null,
        location: root.find(s.location).first().text().trim() || null,
        url: jobKey ? INDEED.viewJobPath(jobKey) : null,
      };
    });
}

/**
 * Sonuç sayfası: önce gömülü JSON (alanları en eksiksiz kaynak), yoksa kartlar. İkisi de yoksa selector hatası.
 * Sonraki sayfa: sayfa doluysa (sayfa boyu kadar ilan) vardır; tekrar eden ilanlar tarama döngüsünde ayrıca durdurur.
 */
export function parseIndeedPage(html: string): ParsedPage {
  let results: IndeedResult[] | null = null;
  let parseError: ScrapeError | null = null;
  try {
    results = embeddedResults(html);
  } catch (e) {
    parseError = e as ScrapeError;
  }
  const cards = results ? results.map(fromResult) : domCards(html);
  if (!results && !cards.length) {
    if (parseError) throw parseError;
    throw new ScrapeError('selector', `İlan verisi bulunamadı (gömülü veri ve ${INDEED.selectors.card} yok); sayfa düzeni değişmiş olabilir`);
  }
  return { cards, hasNextPage: cards.length >= INDEED.pageSize };
}
