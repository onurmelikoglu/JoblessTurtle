import { createHash } from 'crypto';
import type { ScrapedJobView } from '../contracts/scrapers';
import type { ServerShape } from '../contracts/wire';
import { detectLocation } from './geo';
import { companyNameKey } from './job-search';
import { ScraperSource } from './scraper-config';
import { fold, truncate } from './text';

/**
 * Tarayıcıların ilan kartından okuduğu ham alanlar. Sayfada olmayan bilgi boş bırakılır; tahmin edilmez.
 * dateIsUpdate: sitedeki tarih yayın değil güncelleme tarihidir (yayın tarihi bilinmez).
 */
export interface RawCard {
  platformId: string | null;
  title: string | null;
  company: string | null;
  location: string | null;
  url: string | null;
  companyUrl?: string | null;
  description?: string | null;
  employmentType?: string | null;
  workModeText?: string | null;
  publishedAt?: Date | null;
  publishedText?: string | null;
  dateIsUpdate?: boolean;
}

export type WorkMode = 'onsite' | 'hybrid' | 'remote';

/** Standart ilan modeli; her site bu biçime dönüştürülür. */
export interface ScrapedListing {
  source: ScraperSource;
  externalId: string;
  companyName: string;
  jobTitle: string;
  city: string;
  district: string | null;
  jobUrl: string;
  companyUrl: string | null;
  description: string | null;
  employmentType: string | null;
  workMode: WorkMode | null;
  publishedAt: Date | null;
  publishedText: string | null;
}

export type CardRejection = 'missing_title' | 'missing_company' | 'missing_city' | 'missing_url';

const DESCRIPTION_LIMIT = 2000;
const FIELD_LIMIT = 300;
const DAY_MS = 86_400_000;
const PART_SEPARATOR = /\s+-\s+|,|\//;
const PARENTHETICAL = /\s*\([^)]*\)\s*/g;
const MORE_LOCATIONS = /\s*\+\s*\d+.*$/;
const TRACKING_PARAM = /^(utm_|fbclid$|gclid$|ref$|from$)/i;
/** İstanbul'un yaka adı il adına eklenir ("İstanbul Anadolu Yakası - Kadıköy", "İstanbul Avrupa"); il İstanbul'dur. */
const ISTANBUL_SIDE = /(İstanbul|Istanbul)\s+(Anadolu|Avrupa|Asya)(\s+Yakas[ıi])?/gu;

const clean = (value: string | null | undefined, limit = FIELD_LIMIT) => {
  const text = (value ?? '').replace(/\s+/g, ' ').trim();
  return text ? truncate(text, limit) : null;
};

/** İlan bağlantısı mutlak https adrese çevrilir; parça ve izleme parametreleri atılır. */
export function canonicalJobUrl(raw: string | null | undefined, origin: string): string | null {
  if (!raw?.trim()) return null;
  let url: URL;
  try {
    url = new URL(raw.trim(), origin);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  url.protocol = 'https:';
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) if (TRACKING_PARAM.test(key)) url.searchParams.delete(key);
  return url.toString();
}

/** Platformun ilan numarası yoksa kimlik, sadeleştirilmiş ilan adresinin özetidir (aynı adres her zaman aynı kimliği verir). */
export function externalIdOf(platformId: string | null | undefined, canonicalUrl: string): string {
  const id = platformId?.trim();
  if (id) return id;
  return `u-${createHash('sha256').update(canonicalUrl.replace(/^https?:\/\/(www\.)?/, '').toLowerCase()).digest('hex').slice(0, 24)}`;
}

export function workModeOf(text: string | null | undefined): WorkMode | null {
  const f = fold(text);
  if (!f) return null;
  if (/\b(hibrit|hybrid)\b/.test(f)) return 'hybrid';
  if (/\b(uzaktan|remote|evden)\b/.test(f)) return 'remote';
  if (/\b(is yerinde|ofiste|on site|onsite|yerinde)\b/.test(f)) return 'onsite';
  return null;
}

/**
 * Kart konumunu şehir ve ilçeye ayırır: "İstanbul(Avr.)", "İstanbul(Tümü)", "İzmir +81 il daha" → ilk şehir; "İstanbul(Asya) - Kadıköy" → İstanbul, Kadıköy;
 * "Kağıthane" (İstanbul ilçesi) → İstanbul, Kağıthane; "İstanbul Anadolu Yakası - Kadıköy" → İstanbul, Kadıköy. Konum aranan şehrin bir parçasıysa şehir adı aranan şehirden gelir.
 */
export function splitLocation(location: string | null | undefined, searchedCity: string | null): { city: string | null; district: string | null } {
  const text = clean(location)?.replace(ISTANBUL_SIDE, 'İstanbul').replace(PARENTHETICAL, ' ').replace(MORE_LOCATIONS, '').replace(/\s+/g, ' ').trim();
  if (!text) return { city: null, district: null };
  const parts = [...new Map(text.split(PART_SEPARATOR).map((p) => p.trim()).filter(Boolean).map((p) => [fold(p), p])).values()];
  const searched = fold(searchedCity);
  const cityPart = parts.find((p) => searched && fold(p) === searched);
  const detected = detectLocation(text);
  if (cityPart) {
    const district = parts.find((p) => p !== cityPart) ?? null;
    return { city: searchedCity!.trim(), district };
  }
  if (detected.district) return { city: 'İstanbul', district: detected.district };
  return { city: parts[0] ?? null, district: parts[1] ?? null };
}

/** Kartlardaki göreli tarih ("Bugün", "2 gün", "3 saat önce"): kesin değilse ("30+ gün", "Son 1 Hafta") tarih üretilmez. */
export function relativeDate(text: string | null | undefined, now: Date): Date | null {
  const f = fold(text);
  if (!f || /\+/.test(text ?? '') || /^son\b/.test(f)) return null;
  const startOfDay = (offsetDays: number) => {
    const d = new Date(now.getTime() - offsetDays * DAY_MS);
    d.setUTCHours(0, 0, 0, 0);
    return d;
  };
  if (/\b(bugun|today|az once|just posted|simdi)\b/.test(f)) return startOfDay(0);
  if (/\b(dun|yesterday)\b/.test(f)) return startOfDay(1);
  if (/\b\d+\s*(dakika|dk|saat|minute|hour)/.test(f)) return startOfDay(0);
  const days = f.match(/\b(\d+)\s*(gun|day)/);
  if (days) return startOfDay(Number(days[1]));
  const weeks = f.match(/\b(\d+)\s*(hafta|week)/);
  if (weeks) return startOfDay(Number(weeks[1]) * 7);
  return null;
}

/** Kartı standart modele çevirir; zorunlu alanlardan biri yoksa ilan uydurulmaz, neden döner. */
export function normalizeCard(source: ScraperSource, card: RawCard, ctx: { origin: string; searchedCity: string | null; now: Date }): ScrapedListing | CardRejection {
  const title = clean(card.title);
  if (!title) return 'missing_title';
  const company = clean(card.company);
  if (!company) return 'missing_company';
  const jobUrl = canonicalJobUrl(card.url, ctx.origin);
  if (!jobUrl) return 'missing_url';
  const { city, district } = splitLocation(card.location, ctx.searchedCity);
  if (!city) return 'missing_city';
  const publishedText = clean(card.publishedText, 60);
  return {
    source,
    externalId: externalIdOf(card.platformId, jobUrl),
    companyName: company,
    jobTitle: title,
    city,
    district,
    jobUrl,
    companyUrl: canonicalJobUrl(card.companyUrl, ctx.origin),
    description: clean(card.description, DESCRIPTION_LIMIT),
    employmentType: clean(card.employmentType, 80),
    workMode: workModeOf(card.workModeText) ?? workModeOf(card.location),
    publishedAt: card.dateIsUpdate ? null : (card.publishedAt ?? relativeDate(publishedText, ctx.now)),
    publishedText: publishedText && card.dateIsUpdate ? `güncellendi: ${publishedText}` : publishedText,
  };
}

export const isRejection = (value: ScrapedListing | CardRejection): value is CardRejection => typeof value === 'string';

const CONFIDENTIAL_COMPANY = /^(gizli|confidential|isim gizli|firma adi gizli|gizli firma|gizli sirket)( firma| sirket| company)?$/;

/** Sitede adı gizlenmiş firma ("Gizli Firma"): ilan kaydedilir ama çalışma alanına firma olarak aktarılmaz. */
export function isConfidentialCompany(name: string): boolean {
  return CONFIDENTIAL_COMPANY.test(fold(name));
}

/** Yardımcı benzerlik anahtarı: firma adının çekirdeği + sadeleştirilmiş unvan. Farklı numarayla yeniden yayımlanan ilanı yakalar. */
export function similarityKeyOf(companyName: string, jobTitle: string): string {
  return `${companyNameKey(companyName)}|${fold(jobTitle)}`;
}

/** İçerik özeti: değişirse kayıt güncellenir. Göreli tarih metni ("2 gün") her gün değiştiği için dahil edilmez. */
export function contentHashOf(l: Pick<ScrapedListing, 'companyName' | 'jobTitle' | 'city' | 'district' | 'employmentType' | 'workMode' | 'description' | 'companyUrl' | 'jobUrl'>): string {
  const parts = [l.companyName, l.jobTitle, l.city, l.district, l.employmentType, l.workMode, l.description, l.companyUrl, l.jobUrl];
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
}

/** Yerel süzgeç: anahtar kelime boşsa her ilan geçer; değilse unvan ya da firma adında geçmelidir. */
export function matchesKeywords(listing: Pick<ScrapedListing, 'jobTitle' | 'companyName'>, keywords: string[]): boolean {
  const wanted = keywords.map(fold).filter(Boolean);
  if (!wanted.length) return true;
  const haystack = ` ${fold(listing.jobTitle)} ${fold(listing.companyName)} `;
  return wanted.some((k) => haystack.includes(` ${k} `) || haystack.includes(` ${k}`));
}

/** Profilin şehir seçimi ("İstanbul; İstanbul (Anadolu Yakası); Kocaeli") sadeleştirilmiş şehir adlarına iner. */
export function cityKeysOf(selection: string | null | undefined): Set<string> {
  return new Set(
    (selection ?? '')
      .split(';')
      .map((part) => fold(part.replace(/\(.*\)/, '')))
      .filter(Boolean),
  );
}

/** Şehir seçimi yoksa her ilan uyar; uzaktan ilanlar şehirden bağımsızdır (uygunluğu profil süzgeci belirler). */
export function listingInCities(listing: Pick<ScrapedListing, 'city' | 'workMode'>, cityKeys: Set<string>): boolean {
  return !cityKeys.size || listing.workMode === 'remote' || cityKeys.has(fold(listing.city));
}

export type ScrapedJobStatus = 'active' | 'missing' | 'expired';

/**
 * Durum yaşam döngüsü: tarama ilanı görürse "active"; missingAfter süresince görülmezse "missing"; expireAfter süresince
 * görülmezse "expired". Kayıt silinmez; ilan yeniden görülürse yeniden "active" olur.
 */
export function staleCutoffs(now: Date, config: { missing_after_hours: number; expire_after_days: number }) {
  return { missingBefore: new Date(now.getTime() - config.missing_after_hours * 3600_000), expiredBefore: new Date(now.getTime() - config.expire_after_days * DAY_MS) };
}

export interface ScrapedJobRow {
  id: string;
  source: string;
  externalId: string;
  companyName: string;
  jobTitle: string;
  city: string;
  district: string | null;
  jobUrl: string;
  companyUrl: string | null;
  description: string | null;
  employmentType: string | null;
  workMode: string | null;
  publishedAt: Date | null;
  publishedText: string | null;
  status: string;
  duplicateOfId: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  contentChangedAt: Date | null;
}

/** API'nin ve diğer servislerin gördüğü ilan biçimi (snake_case sözleşme). */
export function toPublicJob(row: ScrapedJobRow): ServerShape<ScrapedJobView> {
  return {
    id: row.id,
    source: row.source,
    external_id: row.externalId,
    company_name: row.companyName,
    job_title: row.jobTitle,
    city: row.city,
    district: row.district,
    job_url: row.jobUrl,
    company_url: row.companyUrl,
    description: row.description,
    employment_type: row.employmentType,
    work_mode: row.workMode,
    published_at: row.publishedAt,
    published_text: row.publishedText,
    status: row.status as ScrapedJobView['status'],
    duplicate_of: row.duplicateOfId,
    first_seen_at: row.firstSeenAt,
    last_seen_at: row.lastSeenAt,
    content_changed_at: row.contentChangedAt,
  };
}

