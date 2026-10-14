import { evaluateLocation, ISTANBUL_DISTRICTS, RegionRules } from './geo';
import { fold, isTurkishUrl } from './text';
import { classifyTitle, normalizeTitle, TitleRules } from './titles';

/**
 * Ortak firma kataloğu: bir çalışma alanında bulunan firmanın kamuya açık bilgileri burada birikir ve
 * kriterleri uyan diğer çalışma alanlarına yapay zekâ çağrısı yapılmadan aktarılır. Bu dosya saf kurallardır;
 * veritabanı işlemleri engine/catalog.service.ts içindedir.
 */
export interface CatalogOffice {
  label: string | null;
  kind: string;
  city: string | null;
  district: string | null;
  address: string | null;
}

export interface CatalogSource {
  kind: string;
  config: Record<string, string>;
}

export interface CatalogContact {
  email: string;
  kind: string;
  sourceUrl: string | null;
}

export interface CatalogJob {
  title: string;
  status: 'open' | 'closed';
  firstSeenAt: string;
  lastSeenAt: string;
  closedAt: string | null;
  url: string | null;
  location: string | null;
}

export interface CatalogFacts {
  key: string;
  name: string;
  normalizedName: string;
  canonicalDomain: string | null;
  website: string | null;
  careersUrl: string | null;
  linkedinUrl: string | null;
  groupName: string | null;
  sectors: string[];
  services: string[];
  summary: string | null;
  employeeRange: string | null;
  employeeCount: number | null;
  cities: string[];
  offices: CatalogOffice[];
  sources: CatalogSource[];
  contacts: CatalogContact[];
  jobs: CatalogJob[];
  discoveredFor: string[];
  researchedAt: Date | null;
  contactsSearchedAt: Date | null;
  officesSearchedAt: Date | null;
}

export const CATALOG_LIMITS = { sectors: 12, services: 30, offices: 10, sources: 6, contacts: 20, jobs: 80, discoveredFor: 60 };

const NAME_KEY_PREFIX = 'name:';
const MIN_NAME_KEY_LENGTH = 3;
const MIN_FAMILY_PHRASE_TOKENS = 2;

/** Alan adı firmayı kesin tanımlar; alan adı bilinmiyorsa sadeleştirilmiş ad kullanılır. */
export function catalogKeyOf(c: { canonicalDomain: string | null; normalizedName: string }): string | null {
  if (c.canonicalDomain) return c.canonicalDomain;
  return c.normalizedName.length >= MIN_NAME_KEY_LENGTH ? `${NAME_KEY_PREFIX}${c.normalizedName}` : null;
}

export function isNameKey(key: string) {
  return key.startsWith(NAME_KEY_PREFIX);
}

function union(a: string[], b: string[], limit: number) {
  const seen = new Map<string, string>();
  for (const value of [...a, ...b]) {
    const trimmed = value?.trim();
    if (trimmed && !seen.has(fold(trimmed))) seen.set(fold(trimmed), trimmed);
  }
  return [...seen.values()].slice(0, limit);
}

function latest(a: Date | null, b: Date | null) {
  if (!a || !b) return a ?? b;
  return a.getTime() >= b.getTime() ? a : b;
}

function jobKey(job: CatalogJob) {
  return normalizeTitle(job.title);
}

/** Aynı unvan için en son görülen kayıt kalır; liste en yeni ilanlarla sınırlanır. */
export function mergeCatalogJobs(existing: CatalogJob[], incoming: CatalogJob[]): CatalogJob[] {
  const byTitle = new Map<string, CatalogJob>();
  for (const job of [...existing, ...incoming]) {
    const key = jobKey(job);
    if (!key) continue;
    const current = byTitle.get(key);
    if (!current) {
      byTitle.set(key, job);
      continue;
    }
    const newer = job.lastSeenAt >= current.lastSeenAt ? job : current;
    byTitle.set(key, { ...newer, firstSeenAt: job.firstSeenAt < current.firstSeenAt ? job.firstSeenAt : current.firstSeenAt });
  }
  return [...byTitle.values()].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt)).slice(0, CATALOG_LIMITS.jobs);
}

function mergeContacts(existing: CatalogContact[], incoming: CatalogContact[], dead: Set<string>) {
  const byEmail = new Map<string, CatalogContact>();
  for (const contact of [...existing, ...incoming]) if (!dead.has(contact.email)) byEmail.set(contact.email, contact);
  return [...byEmail.values()].slice(0, CATALOG_LIMITS.contacts);
}

/** Aynı tür ve ayardaki kaynak bir kez tutulur. */
function mergeSources(existing: CatalogSource[], incoming: CatalogSource[]) {
  const unique = new Map<string, CatalogSource>();
  for (const source of [...existing, ...incoming]) {
    const key = `${source.kind}|${JSON.stringify(Object.entries(source.config ?? {}).sort())}`;
    if (!unique.has(key)) unique.set(key, source);
  }
  return [...unique.values()].slice(0, CATALOG_LIMITS.sources);
}

function citiesOf(offices: CatalogOffice[]) {
  return union([], offices.map((o) => o.city ?? ''), CATALOG_LIMITS.offices);
}

/**
 * Bir çalışma alanından gelen güncel bilgiyi katalog kaydıyla birleştirir. Kimlik alanlarında ilk bilinen değer
 * korunur; listeler birleşir; ofis ve çalışan sayısı gibi tekil bilgilerde gelen dolu değer öne geçer.
 * Geçersizliği kesinleşmiş adresler (dead) kataloğa girmez, girmişse çıkarılır.
 */
export function mergeCatalog(existing: CatalogFacts | null, incoming: CatalogFacts, opts: { dead?: Set<string>; discoveredFor?: string[] } = {}): CatalogFacts {
  const dead = opts.dead ?? new Set<string>();
  const discoveredFor = (opts.discoveredFor ?? []).map(normalizeTitle).filter(Boolean);
  if (!existing) {
    return {
      ...incoming,
      sectors: union([], incoming.sectors, CATALOG_LIMITS.sectors),
      services: union([], incoming.services, CATALOG_LIMITS.services),
      offices: incoming.offices.slice(0, CATALOG_LIMITS.offices),
      cities: citiesOf(incoming.offices),
      sources: mergeSources([], incoming.sources),
      contacts: mergeContacts([], incoming.contacts, dead),
      jobs: mergeCatalogJobs([], incoming.jobs),
      discoveredFor: union(incoming.discoveredFor, discoveredFor, CATALOG_LIMITS.discoveredFor),
    };
  }
  const canonicalDomain = existing.canonicalDomain ?? incoming.canonicalDomain;
  const offices = incoming.offices.length ? incoming.offices.slice(0, CATALOG_LIMITS.offices) : existing.offices;
  const hasNewSize = !!incoming.employeeRange;
  return {
    key: canonicalDomain ?? existing.key,
    name: existing.name,
    normalizedName: existing.normalizedName,
    canonicalDomain,
    website: existing.website ?? incoming.website,
    careersUrl: [incoming.careersUrl, existing.careersUrl].find(isTurkishUrl) ?? existing.careersUrl ?? incoming.careersUrl,
    linkedinUrl: existing.linkedinUrl ?? incoming.linkedinUrl,
    groupName: existing.groupName ?? incoming.groupName,
    sectors: union(existing.sectors, incoming.sectors, CATALOG_LIMITS.sectors),
    services: union(existing.services, incoming.services, CATALOG_LIMITS.services),
    summary: incoming.summary ?? existing.summary,
    employeeRange: hasNewSize ? incoming.employeeRange : existing.employeeRange,
    employeeCount: hasNewSize ? incoming.employeeCount : existing.employeeCount,
    cities: offices.length ? citiesOf(offices) : existing.cities,
    offices,
    sources: mergeSources(existing.sources, incoming.sources),
    contacts: mergeContacts(existing.contacts, incoming.contacts, dead),
    jobs: mergeCatalogJobs(existing.jobs, incoming.jobs),
    discoveredFor: union(existing.discoveredFor, [...incoming.discoveredFor, ...discoveredFor], CATALOG_LIMITS.discoveredFor),
    researchedAt: latest(existing.researchedAt, incoming.researchedAt),
    contactsSearchedAt: latest(existing.contactsSearchedAt, incoming.contactsSearchedAt),
    officesSearchedAt: latest(existing.officesSearchedAt, incoming.officesSearchedAt),
  };
}

export type CatalogProfile = TitleRules & RegionRules & { excludedSectors: string[] };
export type CatalogRegion = 'in' | 'near' | 'unknown' | 'out';

export interface CatalogMatch {
  /** job: firmada bu unvanla ilan görülmüş; discovered: firma bu unvan ailesi aranırken bulunmuş. */
  signal: 'job' | 'discovered';
  title: 'exact' | 'adjacent';
  region: CatalogRegion;
  score: number;
}

const REGION_SCORE: Record<CatalogRegion, number> = { in: 2, near: 1, unknown: 0, out: 0 };
const JOB_SIGNAL_SCORE = 4;
const EXACT_TITLE_SCORE = 2;

function contains(haystack: string, needle: string) {
  return ` ${haystack} `.includes(` ${needle} `);
}

/** İki unvan aynı aileden sayılır: eşitse ya da en az iki sözcüklü biri diğerinin içinde geçiyorsa. */
function sameFamily(a: string, b: string) {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.split(' ').length >= MIN_FAMILY_PHRASE_TOKENS && contains(long, short);
}

function familyMatch(profile: TitleRules, discoveredFor: string[]): 'exact' | 'adjacent' | null {
  const normalized = (titles: string[]) => titles.map(normalizeTitle).filter(Boolean);
  const excluded = normalized(profile.excludedTitles);
  const usable = discoveredFor.filter((d) => !excluded.some((x) => contains(d, x)));
  if (normalized(profile.exactTitles).some((t) => usable.some((d) => sameFamily(d, t)))) return 'exact';
  if (normalized(profile.adjacentTitles).some((t) => usable.some((d) => sameFamily(d, t)))) return 'adjacent';
  return null;
}

function jobMatch(profile: TitleRules, jobs: CatalogJob[]): 'exact' | 'adjacent' | null {
  const matches = new Set(jobs.map((j) => classifyTitle(j.title, profile).match));
  return matches.has('exact') ? 'exact' : matches.has('adjacent') ? 'adjacent' : null;
}

const ISTANBUL = 'istanbul';
const ISTANBUL_DISTRICT_NAMES = new Set(ISTANBUL_DISTRICTS.map((d) => fold(d.name)));

function profileCities(profile: RegionRules) {
  const wanted = new Set([profile.city ?? '', ...profile.districtsPrimary, ...profile.districtsConditional].map(fold).filter(Boolean));
  if ([...wanted].some((w) => ISTANBUL_DISTRICT_NAMES.has(w))) wanted.add(ISTANBUL);
  return wanted;
}

/** in: seçilen bölgede ofis var; near: aynı şehirde ama seçilen bölgenin dışında; out: bilinen tüm ofisler başka şehirde. */
export function catalogRegion(profile: RegionRules, c: Pick<CatalogFacts, 'offices' | 'cities'>): CatalogRegion {
  const texts = c.offices.map((o) => [o.district, o.address, o.city].filter(Boolean).join(' ')).filter(Boolean);
  if (!texts.length && !c.cities.length) return 'unknown';
  if (texts.some((t) => ['primary', 'conditional'].includes(evaluateLocation(profile, t)))) return 'in';
  const wanted = profileCities(profile);
  if (!wanted.size) return 'unknown';
  if (c.cities.some((city) => wanted.has(fold(city)))) return 'near';
  return c.cities.length ? 'out' : 'unknown';
}

/**
 * Katalog firması bu arama profiline önerilir mi? Unvan sinyali şarttır (ilan ya da keşif); başka şehirdeki
 * ve hariç tutulan sektördeki firmalar önerilmez.
 */
export function matchCatalogCompany(profile: CatalogProfile, c: Pick<CatalogFacts, 'jobs' | 'discoveredFor' | 'sectors' | 'offices' | 'cities'>): CatalogMatch | null {
  const excludedSectors = profile.excludedSectors.map(fold);
  if (c.sectors.some((s) => excludedSectors.includes(fold(s)))) return null;
  const byJob = jobMatch(profile, c.jobs);
  const title = byJob ?? familyMatch(profile, c.discoveredFor);
  if (!title) return null;
  const region = catalogRegion(profile, c);
  if (region === 'out') return null;
  const signal = byJob ? 'job' : 'discovered';
  return { signal, title, region, score: (signal === 'job' ? JOB_SIGNAL_SCORE : 0) + (title === 'exact' ? EXACT_TITLE_SCORE : 0) + REGION_SCORE[region] };
}

/** Yeni çalışma alanına "bu pozisyonu daha önce açmış" bilgisini taşıyan, profille eşleşen kapanmış ilanlar. */
export function pastJobsFor(profile: TitleRules, jobs: CatalogJob[]): CatalogJob[] {
  return jobs.filter((j) => j.status === 'closed' && ['exact', 'adjacent'].includes(classifyTitle(j.title, profile).match));
}

const OPEN_JOB_FRESH_DAYS = 21;
const DAY_MS = 86_400_000;

/**
 * Başka bir çalışma alanında yakın zamanda açık görülmüş, profille eşleşen ve bağlantısı bilinen ilanlar. Yeni çalışma
 * alanına "teyit gerekli" olarak taşınır; açık olduğunu o çalışma alanının kendi kaynakları doğrular.
 */
export function recentOpenJobsFor(profile: TitleRules, jobs: CatalogJob[], now = Date.now()): CatalogJob[] {
  return jobs.filter((j) => j.status === 'open' && !!j.url && now - new Date(j.lastSeenAt).getTime() < OPEN_JOB_FRESH_DAYS * DAY_MS && ['exact', 'adjacent'].includes(classifyTitle(j.title, profile).match));
}
