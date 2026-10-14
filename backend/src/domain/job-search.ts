import { createHash } from 'crypto';
import { isInTurkey, ISTANBUL_DISTRICTS, workScopeOf } from './geo';
import { fold, normalizeCompanyName } from './text';
import { classifyTitle, normalizeTitle, TitleRules } from './titles';

/**
 * İlan arama motorunun saf kuralları: hangi sorgular çalışacak, bulunan ilan hangi anahtarla tekilleşecek,
 * hangi ilan bu arama profiline uygun sayılacak. Yapay zekâ çağrısı ve kayıt engine/job-search.service.ts içindedir.
 */
export type JobScope = 'tr' | 'remote' | 'relocation';

export const PLATFORM_SETS = {
  tr_major: { scope: 'tr', label: 'LinkedIn ve Indeed', platforms: ['LinkedIn iş ilanları (linkedin.com/jobs)', 'Indeed Türkiye (tr.indeed.com)'] },
  tr_boards: { scope: 'tr', label: 'Kariyer.net ve yerel ilan siteleri', platforms: ['Kariyer.net', 'Youthall', 'Secretcv', 'Eleman.net', 'Yenibiris', 'Toptalent', 'Glassdoor'] },
  tr_company: { scope: 'tr', label: 'Firma kariyer sayfaları ve başvuru panoları', platforms: ['firmaların kendi kariyer sayfaları', 'Greenhouse', 'Lever', 'Workable', 'Teamtailor', 'SmartRecruiters', 'Recruitee', 'Ashby', 'Kolay İK ve Peoplise ilan sayfaları'] },
  remote_world: { scope: 'remote', label: 'Yurt dışı uzaktan ilanlar', platforms: ['LinkedIn (Remote; EMEA, Europe ya da Worldwide)', 'We Work Remotely', 'Wellfound', 'Working Nomads', 'firmaların kendi kariyer sayfaları (remote)'] },
  relocation: { scope: 'relocation', label: 'Yurt dışı ilanlar (taşınma)', platforms: ['LinkedIn', 'firmaların kendi kariyer sayfaları', 'Relocate.me', 'Arbeitnow', 'EURES'] },
} as const satisfies Record<string, { scope: JobScope; label: string; platforms: readonly string[] }>;
export type PlatformSet = keyof typeof PLATFORM_SETS;

export interface JobSearchProfile extends TitleRules {
  city?: string | null;
  districtsPrimary: string[];
  allowRemote: boolean;
  abroadRemote: boolean;
  abroadRelocation: boolean;
  abroadRegions: string[];
}

export interface JobQuery {
  key: string;
  set: PlatformSet;
  scope: JobScope;
  titles: string[];
  location: string;
  /** 0: aranan unvanlar, 1: yakın unvanlar. */
  priority: number;
}

export interface JobQueryStats {
  at: string;
  runs: number;
  returned: number;
  fresh: number;
  /** Art arda yeni ilan getirmeyen çalışma sayısı; sorgunun dinlenme süresini uzatır. */
  dry: number;
}
export type JobQueryLog = Record<string, JobQueryStats>;

const EXACT_TITLES_PER_QUERY = 2;
const ADJACENT_TITLES_PER_QUERY = 5;
const MAX_ADJACENT_TITLES = 15;
const HOUR_MS = 3_600_000;
const BASE_REST_HOURS = 24;
const MAX_REST_HOURS = 8 * 24;
const FORCED_REST_HOURS = 2;
const DEFAULT_COUNTRY = 'Türkiye';
const ISTANBUL = 'İstanbul';
const ISTANBUL_DISTRICT_NAMES = new Set(ISTANBUL_DISTRICTS.map((d) => fold(d.name)));

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function shortHash(text: string) {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

/** Profilin Türkiye'deki arama bölgesi: tek şehir, seçilen şehirler ya da ülke geneli. */
export function searchLocationOf(profile: Pick<JobSearchProfile, 'city' | 'districtsPrimary'>): string {
  if (profile.city) return profile.city;
  const cities = new Set(profile.districtsPrimary.map((d) => (ISTANBUL_DISTRICT_NAMES.has(fold(d)) ? ISTANBUL : d)));
  return cities.size ? [...cities].join(', ') : DEFAULT_COUNTRY;
}

function scopesOf(profile: JobSearchProfile): PlatformSet[] {
  return [
    'tr_major',
    'tr_boards',
    'tr_company',
    ...(profile.abroadRemote ? (['remote_world'] as const) : []),
    ...(profile.abroadRelocation ? (['relocation'] as const) : []),
  ];
}

/** Unvan grubu × kaynak kümesi başına bir sorgu. Anahtar, unvanlar ve bölge değişmedikçe sabittir (verim kaydı buna bağlanır). */
export function buildJobQueries(profile: JobSearchProfile): JobQuery[] {
  const groups = [
    ...chunks(profile.exactTitles, EXACT_TITLES_PER_QUERY).map((titles) => ({ titles, priority: 0 })),
    ...chunks(profile.adjacentTitles.slice(0, MAX_ADJACENT_TITLES), ADJACENT_TITLES_PER_QUERY).map((titles) => ({ titles, priority: 1 })),
  ];
  const queries: JobQuery[] = [];
  for (const group of groups) {
    for (const set of scopesOf(profile)) {
      const scope: JobScope = PLATFORM_SETS[set].scope;
      const location = scope === 'tr' ? searchLocationOf(profile) : scope === 'remote' ? 'Remote (Türkiye\'den çalışılabilir: Worldwide, EMEA, Europe)' : profile.abroadRegions.join(', ') || 'Avrupa';
      const identity = [...group.titles].map(normalizeTitle).sort().join('|');
      queries.push({ key: `${set}:${shortHash(`${identity}@${fold(location)}`)}`, set, scope, titles: group.titles, location, priority: group.priority });
    }
  }
  return queries;
}

function restHours(stats: JobQueryStats) {
  return Math.min(BASE_REST_HOURS * 2 ** stats.dry, MAX_REST_HOURS);
}

/**
 * Sıradaki sorgular: hiç çalışmamışlar önce (aranan unvanlar, sonra yakın unvanlar); ardından dinlenmesi bitenler.
 * Yeni ilan getirmeyen sorgu her seferinde iki kat uzun dinlenir. force: kullanıcı başlattı, dinlenme süresi
 * yalnızca son birkaç saatte çalışmış sorgular için geçerlidir.
 */
export function pickJobQueries(queries: JobQuery[], log: JobQueryLog, opts: { count: number; now?: number; force?: boolean }): JobQuery[] {
  const now = opts.now ?? Date.now();
  const lastRun = (q: JobQuery) => (log[q.key] ? new Date(log[q.key].at).getTime() : 0);
  const due = (q: JobQuery) => {
    const stats = log[q.key];
    if (!stats) return true;
    return now - lastRun(q) >= (opts.force ? FORCED_REST_HOURS : restHours(stats)) * HOUR_MS;
  };
  return queries
    .filter(due)
    .sort((a, b) => Number(!!log[a.key]) - Number(!!log[b.key]) || a.priority - b.priority || lastRun(a) - lastRun(b))
    .slice(0, opts.count);
}

export function noteJobQuery(log: JobQueryLog, key: string, result: { returned: number; fresh: number }, now = new Date()): JobQueryLog {
  const previous = log[key];
  return {
    ...log,
    [key]: {
      at: now.toISOString(),
      runs: (previous?.runs ?? 0) + 1,
      returned: (previous?.returned ?? 0) + result.returned,
      fresh: (previous?.fresh ?? 0) + result.fresh,
      dry: result.fresh > 0 ? 0 : (previous?.dry ?? 0) + 1,
    },
  };
}

const TRACKING_PARAM = /^(utm_|ref$|refid$|ref_|trk|tracking|trackingid$|source$|src$|gh_src$|lever-source|fbclid$|gclid$|mc_|origin$|position$|pagenum$|ebp$|recommendedflavor$|sid$)/i;

/**
 * İlan bağlantısını tekilleştirme için sadeleştirir: izleme parametreleri ve bağlantı çapası atılır; LinkedIn ve
 * Indeed'de ilan numarası esas alınır. Aynı ilanın farklı aramalardan gelen bağlantıları aynı sonuca iner.
 */
export function normalizeListingUrl(raw: string | null | undefined): string | null {
  let url: URL;
  try {
    url = new URL((raw ?? '').trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase();
  if (!host.includes('.')) return null;
  if (/(^|\.)linkedin\.com$/.test(host)) {
    const id = url.searchParams.get('currentJobId') ?? url.pathname.match(/\/jobs\/view\/(?:[^/]*?-)?(\d{6,})\/?$/)?.[1];
    if (id) return `https://www.linkedin.com/jobs/view/${id}`;
  }
  if (/(^|\.)indeed\.com$/.test(host)) {
    const id = url.searchParams.get('jk') ?? url.searchParams.get('vjk');
    if (id) return `https://${host}/viewjob?jk=${id}`;
  }
  for (const key of [...url.searchParams.keys()]) if (TRACKING_PARAM.test(key)) url.searchParams.delete(key);
  url.hash = '';
  url.hostname = host;
  const text = url.toString();
  return text.endsWith('/') && url.pathname !== '/' ? text.slice(0, -1) : text;
}

export function listingExternalId(normalizedUrl: string): string {
  return createHash('sha256').update(normalizedUrl.replace(/^https?:\/\/(www\.)?/, '').toLowerCase()).digest('hex').slice(0, 24);
}

/** Web aramasında bulunan ilanların (hangi platformda olursa olsun) kaydedildiği kaynak türü. */
export const WEB_SEARCH_SOURCE = 'job_search';

const OPEN_TO_TURKEY = /\b(worldwide|anywhere|global|globally|international|emea|europe|european|turkey|turkiye|cet|eet)\b/;

/** Uzaktan ilan Türkiye'den çalışmaya açık mı? Kısıt yazılmamışsa açık sayılır; başka bir bölgeye bağlıysa değildir. */
export function remoteOpenToTurkey(restriction: string | null | undefined): boolean {
  const text = fold(restriction);
  return !text || OPEN_TO_TURKEY.test(text) || /\beu\b/.test(text);
}

export type ListingRejection = 'title' | 'remote_not_wanted' | 'region_locked' | 'abroad_not_wanted' | 'region_not_wanted';

/**
 * Toplayıcı kaynaktan (ilan sitesi, uzaktan çalışma panosu, web araması) gelen ilan bu profile uygun mu?
 * Unvan aranan ya da yakın unvanla eşleşmeli; uzaktan ve yurt dışı ilanlar yalnızca profil bunları istiyorsa alınır.
 */
export function listingRejection(profile: JobSearchProfile, listing: { title: string; locationText?: string | null; workMode?: string | null }): ListingRejection | null {
  if (!['exact', 'adjacent'].includes(classifyTitle(listing.title, profile).match)) return 'title';
  const scope = workScopeOf(listing.locationText, listing.workMode);
  if (scope === 'remote') {
    if (isInTurkey(listing.locationText)) return profile.allowRemote || profile.abroadRemote ? null : 'remote_not_wanted';
    if (!profile.abroadRemote) return 'remote_not_wanted';
    return remoteOpenToTurkey(listing.locationText?.replace(/remote|uzaktan/gi, ' ')) ? null : 'region_locked';
  }
  if (scope === 'abroad') {
    if (!profile.abroadRelocation) return 'abroad_not_wanted';
    const wanted = profile.abroadRegions.map(fold).filter(Boolean);
    return !wanted.length || wanted.some((region) => ` ${fold(listing.locationText)} `.includes(` ${region} `)) ? null : 'region_not_wanted';
  }
  return null;
}

const TRAILING_GENERIC = new Set(['group', 'grup', 'holding', 'teknoloji', 'technology', 'technologies', 'turkiye', 'turkey', 'tr', 'global', 'international']);
const MIN_KEY_LENGTH = 3;

/**
 * Firma adının çekirdeği: "Trendyol Group" ile "Trendyol" aynı firmadır. Yalnızca sondaki genel sözcükler atılır ve
 * geriye anlamlı bir ad kalıyorsa uygulanır; alan adı bilinen iki farklı firmayı birleştirmek için kullanılmaz.
 */
export function companyNameKey(name: string): string {
  const tokens = normalizeCompanyName(name).split(' ').filter(Boolean);
  while (tokens.length > 1 && TRAILING_GENERIC.has(tokens[tokens.length - 1])) tokens.pop();
  const key = tokens.join(' ');
  return key.length >= MIN_KEY_LENGTH ? key : normalizeCompanyName(name);
}
