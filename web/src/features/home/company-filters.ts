import type { CompanyClass, EmployeeRange, EmployeeSize, HomeCompany, HomeOpportunity, WorkScope } from '@/api/types';
import { hostOf } from '@/lib/format';
import { fold, haystack, matchesAll, tokensOf } from '@/lib/text';
import { CATEGORY_INFO, CLASS_INFO, COMPANY_CLASS_ORDER, draftReady, hasEmail } from './model';

export type EmailFilter = 'any' | 'has' | 'missing';
export type CompanySort = 'recommended' | 'newest' | 'name';

/** Çalışan sayısı filtresinin dilimleri; değerler adres çubuğunda da aynen kullanılır. */
export const SIZE_BUCKETS = ['1-10', '11-50', '51-200', '201-1000', '1000+', 'bilinmiyor'] as const;
export type SizeBucket = (typeof SIZE_BUCKETS)[number];
export const UNKNOWN_SIZE: SizeBucket = 'bilinmiyor';

const BUCKET_OF_RANGE: Record<EmployeeRange, SizeBucket> = {
  '1-10': '1-10',
  '11-50': '11-50',
  '51-200': '51-200',
  '201-500': '201-1000',
  '501-1000': '201-1000',
  '1001-5000': '1000+',
  '5001+': '1000+',
};

export function sizeBucketOf(employees: EmployeeSize | null): SizeBucket {
  return employees ? BUCKET_OF_RANGE[employees.range] : UNKNOWN_SIZE;
}

export function sizeCounts(companies: HomeCompany[]): Record<SizeBucket, number> {
  const counts = Object.fromEntries(SIZE_BUCKETS.map((bucket) => [bucket, 0])) as Record<SizeBucket, number>;
  for (const company of companies) counts[sizeBucketOf(company.employees)]++;
  return counts;
}

/** İlan kapsamı filtresi; değerler adres çubuğunda da aynen kullanılır. Konumu bilinmeyen ilan Türkiye dilimindedir. */
export const SCOPE_FILTERS = ['tr', 'uzaktan', 'yurtdisi'] as const;
export type ScopeFilter = (typeof SCOPE_FILTERS)[number];

const FILTER_OF_SCOPE: Record<WorkScope, ScopeFilter> = { local: 'tr', unknown: 'tr', remote: 'uzaktan', abroad: 'yurtdisi' };

export const scopeFilterOf = (opportunity: Pick<HomeOpportunity, 'scope'>): ScopeFilter => FILTER_OF_SCOPE[opportunity.scope];

export function scopeCounts(companies: HomeCompany[]): Record<ScopeFilter, number> {
  const counts = Object.fromEntries(SCOPE_FILTERS.map((scope) => [scope, 0])) as Record<ScopeFilter, number>;
  for (const company of companies) for (const scope of new Set(company.opportunities.map(scopeFilterOf))) counts[scope]++;
  return counts;
}

/** Çalışma şekli filtresi; tahmini değer de sayılır. Firmaya genel başvuru ve şekli bilinmeyen ilan "belirtilmemis"tir. */
export const WORK_MODE_FILTERS = ['yerinde', 'hibrit', 'uzaktan', 'belirtilmemis'] as const;
export type WorkModeFilter = (typeof WORK_MODE_FILTERS)[number];

const FILTER_OF_WORK_MODE: Record<NonNullable<HomeOpportunity['workMode']>, WorkModeFilter> = { onsite: 'yerinde', hybrid: 'hibrit', remote: 'uzaktan' };

export const workModeFilterOf = (opportunity: Pick<HomeOpportunity, 'workMode'>): WorkModeFilter => (opportunity.workMode ? FILTER_OF_WORK_MODE[opportunity.workMode] : 'belirtilmemis');

export function workModeCounts(companies: HomeCompany[]): Record<WorkModeFilter, number> {
  const counts = Object.fromEntries(WORK_MODE_FILTERS.map((mode) => [mode, 0])) as Record<WorkModeFilter, number>;
  for (const company of companies) for (const mode of new Set(company.opportunities.map(workModeFilterOf))) counts[mode]++;
  return counts;
}

/**
 * Bölge filtresi profildeki şehir seçimlerinin kısa adlarını (slug) taşır: "İstanbul (Avrupa Yakası)" → istanbul-avrupa-yakasi.
 * REGION_OTHER hiçbir seçime düşmeyenleri (başka şehir ya da konumu bilinmeyen), REGION_ANY eski "Bölgemde" bağlantısını karşılar.
 */
export const REGION_OTHER = 'diger';
export const REGION_ANY = 'bolgem';

export const regionSlug = (label: string) =>
  fold(label)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

function regionSlugsOf(company: HomeCompany, opportunity: HomeOpportunity | null): string[] {
  const labels = opportunity ? opportunity.regions : company.officeRegions;
  return labels.length ? labels.map(regionSlug) : [REGION_OTHER];
}

const matchesRegion = (wanted: string[], slugs: string[]) => wanted.some((w) => (w === REGION_ANY ? !slugs.includes(REGION_OTHER) : slugs.includes(w)));

export function regionCounts(companies: HomeCompany[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const company of companies) {
    const slugs = company.opportunities.length ? company.opportunities.flatMap((o) => regionSlugsOf(company, o)) : regionSlugsOf(company, null);
    for (const slug of new Set(slugs)) counts[slug] = (counts[slug] ?? 0) + 1;
  }
  return counts;
}

export interface CompanyFilters {
  query: string;
  classes: CompanyClass[];
  sizes: SizeBucket[];
  scopes: ScopeFilter[];
  regions: string[];
  workModes: WorkModeFilter[];
  email: EmailFilter;
  ready: boolean;
  sort: CompanySort;
}

export const DEFAULT_FILTERS: CompanyFilters = { query: '', classes: [], sizes: [], scopes: [], regions: [], workModes: [], email: 'any', ready: false, sort: 'recommended' };

const EMAIL_PARAM: Record<string, EmailFilter> = { var: 'has', yok: 'missing' };
const SORT_PARAM: Record<string, CompanySort> = { yeni: 'newest', ad: 'name' };
const paramOf = <T extends string>(map: Record<string, T>, value: T) => Object.keys(map).find((key) => map[key] === value);

export function parseFilters(params: URLSearchParams): CompanyFilters {
  const classes = (params.get('sinif') ?? '').split(',').filter((c): c is CompanyClass => (COMPANY_CLASS_ORDER as string[]).includes(c));
  const sizes = (params.get('boyut') ?? '').split(',').filter((s): s is SizeBucket => (SIZE_BUCKETS as readonly string[]).includes(s));
  const scopes = (params.get('kapsam') ?? '').split(',').filter((s): s is ScopeFilter => (SCOPE_FILTERS as readonly string[]).includes(s));
  const workModes = (params.get('sekil') ?? '').split(',').filter((s): s is WorkModeFilter => (WORK_MODE_FILTERS as readonly string[]).includes(s));
  const region = params.get('bolge') ?? '';
  const regions = region === '1' ? [REGION_ANY] : region.split(',').map(regionSlug).filter(Boolean);
  return {
    query: params.get('q') ?? '',
    classes,
    sizes,
    scopes,
    regions: [...new Set(regions)],
    workModes,
    email: EMAIL_PARAM[params.get('mail') ?? ''] ?? 'any',
    ready: params.get('yazi') === '1',
    sort: SORT_PARAM[params.get('sira') ?? ''] ?? 'recommended',
  };
}

/** Varsayılan değerler adres çubuğuna yazılmaz; böylece bağlantı kısa kalır ve paylaşılabilir. */
export function writeFilters(params: URLSearchParams, filters: CompanyFilters): URLSearchParams {
  const next = new URLSearchParams(params);
  const set = (key: string, value: string | undefined) => (value ? next.set(key, value) : next.delete(key));
  set('q', filters.query || undefined);
  set('sinif', filters.classes.join(',') || undefined);
  set('boyut', filters.sizes.join(',') || undefined);
  set('kapsam', filters.scopes.join(',') || undefined);
  set('bolge', filters.regions.join(',') || undefined);
  set('sekil', filters.workModes.join(',') || undefined);
  set('mail', paramOf(EMAIL_PARAM, filters.email));
  set('yazi', filters.ready ? '1' : undefined);
  set('sira', paramOf(SORT_PARAM, filters.sort));
  return next;
}

export function activeFilterCount(filters: CompanyFilters): number {
  const lists = [filters.classes, filters.sizes, filters.scopes, filters.regions, filters.workModes];
  return Number(!!filters.query.trim()) + lists.filter((list) => list.length > 0).length + Number(filters.email !== 'any') + Number(filters.ready);
}

const haystacks = new WeakMap<HomeCompany, string>();

/** Arama kutusunun baktığı her şey: firma adı, sektör, şehir/ilçe/adres, ilan başlığı ve konumu, sınıf ve etiket, site ve alıcı adresi. */
function haystackOf(company: HomeCompany): string {
  const cached = haystacks.get(company);
  if (cached !== undefined) return cached;
  const built = haystack([
    company.name,
    ...company.sectors,
    ...company.cities,
    ...company.offices.flatMap((o) => [o.district, o.city, o.address, o.label]),
    CLASS_INFO[company.class].short,
    hostOf(company.website),
    hostOf(company.careersUrl),
    ...company.opportunities.flatMap((o) => [o.title, o.location, CATEGORY_INFO[o.category]?.tag, o.draft?.toEmail, o.groupSuggestion?.email]),
  ]);
  haystacks.set(company, built);
  return built;
}

function opportunityFilter(filters: CompanyFilters): ((company: HomeCompany, o: HomeOpportunity) => boolean) | null {
  if (filters.email === 'any' && !filters.ready && !filters.scopes.length && !filters.regions.length && !filters.workModes.length) return null;
  return (company, o) =>
    (filters.email === 'any' || (filters.email === 'has') === hasEmail(o)) &&
    (!filters.ready || draftReady(o)) &&
    (!filters.scopes.length || filters.scopes.includes(scopeFilterOf(o))) &&
    (!filters.workModes.length || filters.workModes.includes(workModeFilterOf(o))) &&
    (!filters.regions.length || matchesRegion(filters.regions, regionSlugsOf(company, o)));
}

/** Görünür fırsatı olmayan (ilk araştırması süren) firma yalnızca bölge filtresinde, ofisine göre kalır. */
const keepsWithoutOpportunities = (company: HomeCompany, filters: CompanyFilters) =>
  filters.email === 'any' && !filters.ready && !filters.scopes.length && !filters.workModes.length && matchesRegion(filters.regions, regionSlugsOf(company, null));

const newestAt = (company: HomeCompany) => [company.foundAt, ...company.opportunities.map((o) => o.foundAt)].reduce((latest, at) => (at > latest ? at : latest));

/**
 * Filtreler birlikte uygulanır (VE). Mail, yazı, kapsam, bölge ve çalışma şekli filtreleri fırsat düzeyindedir: firma, koşulu sağlayan
 * en az bir fırsatı varsa kalır ve yalnızca o fırsatlarıyla listelenir.
 */
export function filterCompanies(companies: HomeCompany[], filters: CompanyFilters): HomeCompany[] {
  const tokens = tokensOf(filters.query);
  const keepOpportunity = opportunityFilter(filters);
  const result: HomeCompany[] = [];
  for (const company of companies) {
    if (filters.classes.length && !filters.classes.includes(company.class)) continue;
    if (filters.sizes.length && !filters.sizes.includes(sizeBucketOf(company.employees))) continue;
    if (tokens.length && !matchesAll(tokens, haystackOf(company))) continue;
    if (!keepOpportunity) {
      result.push(company);
      continue;
    }
    if (!company.opportunities.length) {
      if (keepsWithoutOpportunities(company, filters)) result.push(company);
      continue;
    }
    const opportunities = company.opportunities.filter((o) => keepOpportunity(company, o));
    if (opportunities.length) result.push(opportunities.length === company.opportunities.length ? company : { ...company, opportunities });
  }
  if (filters.sort === 'newest') return result.sort((a, b) => (newestAt(a) < newestAt(b) ? 1 : -1));
  if (filters.sort === 'name') return result.sort((a, b) => a.name.localeCompare(b.name, 'tr'));
  return result;
}

/** Bildirimden gelinen odak: yalnızca bu ilanlar (iş kaydı) ya da fırsatlar gösterilir. */
export interface CompanyFocus {
  jobs: string[];
  opportunities: string[];
}

export const isFocused = (focus: CompanyFocus) => focus.jobs.length + focus.opportunities.length > 0;

/** Odaktaki ilanları taşıyan firmalar, yalnızca o fırsatlarıyla; diğer filtreler uygulanmaz. */
export function focusCompanies(companies: HomeCompany[], focus: CompanyFocus): HomeCompany[] {
  const jobs = new Set(focus.jobs);
  const opportunities = new Set(focus.opportunities);
  const result: HomeCompany[] = [];
  for (const company of companies) {
    const matched = company.opportunities.filter((o) => opportunities.has(o.id) || (o.jobId !== null && jobs.has(o.jobId)));
    if (matched.length) result.push(matched.length === company.opportunities.length ? company : { ...company, opportunities: matched });
  }
  return result;
}

export function groupByClass(companies: HomeCompany[]): { companyClass: CompanyClass; companies: HomeCompany[] }[] {
  return COMPANY_CLASS_ORDER.map((companyClass) => ({ companyClass, companies: companies.filter((c) => c.class === companyClass) })).filter((group) => group.companies.length > 0);
}

export const SCOPE_LABELS: Record<ScopeFilter, { label: string; hint: string }> = {
  tr: { label: 'Türkiye', hint: "Türkiye'deki ilanlar ve firmaya genel başvurular" },
  uzaktan: { label: 'Uzaktan', hint: 'Uzaktan çalışılabilen ilanlar' },
  yurtdisi: { label: 'Yurt dışı', hint: 'Taşınmayı gerektiren yurt dışı ilanları' },
};

export const WORK_MODE_LABELS: Record<WorkModeFilter, { label: string; hint: string }> = {
  yerinde: { label: 'Yerinde', hint: 'İş yerinde çalışılan ilanlar (ilanda yazmıyorsa tahmini)' },
  hibrit: { label: 'Hibrit', hint: 'Hibrit çalışılan ilanlar (ilanda yazmıyorsa tahmini)' },
  uzaktan: { label: 'Uzaktan', hint: 'Uzaktan çalışılan ilanlar (ilanda yazmıyorsa tahmini)' },
  belirtilmemis: { label: 'Belirtilmemiş', hint: 'Çalışma şekli bilinmeyen ilanlar ve firmaya genel başvurular' },
};

export const SIZE_LABELS: Record<SizeBucket, string> = { '1-10': '1-10', '11-50': '11-50', '51-200': '51-200', '201-1000': '201-1.000', '1000+': '1.000+', bilinmiyor: 'Bilinmiyor' };

export const REGION_OTHER_LABEL = 'Diğer / bilinmiyor';

/** Açılır panelde duran filtrelerden seçili olanlar; arama kutusu ve sınıf düğmeleri her zaman göründüğü için burada yoktur. */
export interface FilterPill {
  key: string;
  label: string;
  without: CompanyFilters;
}

const without = <T>(list: T[], value: T) => list.filter((item) => item !== value);

export function activeFilterPills(filters: CompanyFilters, regionLabels: string[]): FilterPill[] {
  const regionLabel = new Map(regionLabels.map((label) => [regionSlug(label), label]));
  const pills: FilterPill[] = [];
  for (const region of filters.regions) {
    const label = region === REGION_ANY ? 'Bölgem' : region === REGION_OTHER ? REGION_OTHER_LABEL : (regionLabel.get(region) ?? region);
    pills.push({ key: `bolge:${region}`, label: `Bölge: ${label}`, without: { ...filters, regions: without(filters.regions, region) } });
  }
  for (const mode of filters.workModes) pills.push({ key: `sekil:${mode}`, label: WORK_MODE_LABELS[mode].label, without: { ...filters, workModes: without(filters.workModes, mode) } });
  for (const scope of filters.scopes) pills.push({ key: `kapsam:${scope}`, label: SCOPE_LABELS[scope].label, without: { ...filters, scopes: without(filters.scopes, scope) } });
  for (const size of filters.sizes) pills.push({ key: `boyut:${size}`, label: `${SIZE_LABELS[size]} çalışan`, without: { ...filters, sizes: without(filters.sizes, size) } });
  if (filters.email !== 'any') pills.push({ key: 'mail', label: filters.email === 'has' ? 'Mail adresi var' : 'Mail adresi yok', without: { ...filters, email: 'any' } });
  if (filters.ready) pills.push({ key: 'yazi', label: 'Yazısı hazır', without: { ...filters, ready: false } });
  return pills;
}
