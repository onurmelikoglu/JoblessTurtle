import * as cheerio from 'cheerio';
import { RawCard } from '../../../domain/scraped-jobs';
import { ISINOLSUN } from '../selectors/isinolsun';
import { ParsedPage, ScrapeError } from '../types';

interface IsinolsunJob {
  jobId?: string;
  positionName?: string;
  companyName?: string;
  cityName?: string | null;
  townName?: string | null;
  neighbourhood?: string | null;
  shareUrl?: string;
  workType?: number;
  durationDayText?: string | null;
}

/** "2s" saat, "3g" gün kısaltmaları açılır; "15+ gün" gibi kesin olmayanlar olduğu gibi kalır (tarih üretilmez). */
export function isinolsunAge(text: string | null | undefined): string | null {
  const value = text?.trim();
  if (!value) return null;
  const short = value.match(/^(\d+)\s*([sg])$/i);
  if (!short) return value;
  return `${short[1]} ${short[2].toLowerCase() === 's' ? 'saat' : 'gün'}`;
}

const NEIGHBOURHOOD = /\bmah(\.|alle(si)?)?$/i;

const addressParts = (address: string | null | undefined) =>
  (address ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);

/** Kart adresinden il ve ilçe: "Cumhuriyet Mah., Şişli, İstanbul" → "İstanbul - Şişli" (mahalle ayrı alandır). */
export function isinolsunLocation(address: string | null | undefined): string | null {
  const parts = addressParts(address).filter((p) => !NEIGHBOURHOOD.test(p));
  if (!parts.length) return null;
  const [city, ...rest] = parts.reverse();
  return rest.length ? `${city} - ${rest[0]}` : city;
}

/** Kart adresindeki mahalle: "Cumhuriyet Mah., Şişli, İstanbul" → "Cumhuriyet Mah.". */
export function isinolsunNeighbourhood(address: string | null | undefined): string | null {
  return addressParts(address).find((p) => NEIGHBOURHOOD.test(p)) ?? null;
}

function fromJob(job: IsinolsunJob): RawCard {
  return {
    platformId: job.jobId ?? null,
    title: job.positionName ?? null,
    company: job.companyName ?? null,
    location: job.cityName ? (job.townName ? `${job.cityName} - ${job.townName}` : job.cityName) : null,
    url: job.shareUrl ?? null,
    address: job.neighbourhood?.trim() || null,
    employmentType: (job.workType != null && ISINOLSUN.workTypes[job.workType]) || null,
    publishedText: isinolsunAge(job.durationDayText),
  };
}

/** Sunucudaki sayfa: gömülü veri (alanları en eksiksiz kaynak); yoksa sayfa düzeni değişmiştir. */
export function parseIsinolsunPage(html: string): ParsedPage {
  const $ = cheerio.load(html);
  const embedded = $(`script#${ISINOLSUN.embeddedData}`).first().text();
  if (!embedded) throw new ScrapeError('selector', `Gömülü ilan verisi (${ISINOLSUN.embeddedData}) bulunamadı; sayfa düzeni değişmiş olabilir`);
  let props: { jobs?: IsinolsunJob[]; pageNumber?: number; pageCount?: number };
  try {
    props = JSON.parse(embedded)?.props?.pageProps ?? {};
  } catch (e) {
    throw new ScrapeError('parse', `Gömülü ilan verisi okunamadı: ${(e as Error).message}`);
  }
  if (!Array.isArray(props.jobs)) throw new ScrapeError('selector', 'Gömülü veride ilan listesi (jobs) yok; sayfa düzeni değişmiş olabilir');
  return { cards: props.jobs.map(fromJob), hasNextPage: (props.pageNumber ?? 1) < (props.pageCount ?? 1) };
}
