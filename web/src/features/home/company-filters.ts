import type { CompanyClass, EmployeeRange, EmployeeSize, HomeCompany, HomeOpportunity, WorkScope } from '@/api/types';
import { hostOf } from '@/lib/format';
import { haystack, matchesAll, tokensOf } from '@/lib/text';
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

export interface CompanyFilters {
  query: string;
  classes: CompanyClass[];
  sizes: SizeBucket[];
  scopes: ScopeFilter[];
  inRegion: boolean;
  email: EmailFilter;
  ready: boolean;
  sort: CompanySort;
}

export const DEFAULT_FILTERS: CompanyFilters = { query: '', classes: [], sizes: [], scopes: [], inRegion: false, email: 'any', ready: false, sort: 'recommended' };

const EMAIL_PARAM: Record<string, EmailFilter> = { var: 'has', yok: 'missing' };
const SORT_PARAM: Record<string, CompanySort> = { yeni: 'newest', ad: 'name' };
const paramOf = <T extends string>(map: Record<string, T>, value: T) => Object.keys(map).find((key) => map[key] === value);

export function parseFilters(params: URLSearchParams): CompanyFilters {
  const classes = (params.get('sinif') ?? '').split(',').filter((c): c is CompanyClass => (COMPANY_CLASS_ORDER as string[]).includes(c));
  const sizes = (params.get('boyut') ?? '').split(',').filter((s): s is SizeBucket => (SIZE_BUCKETS as readonly string[]).includes(s));
  const scopes = (params.get('kapsam') ?? '').split(',').filter((s): s is ScopeFilter => (SCOPE_FILTERS as readonly string[]).includes(s));
  return {
    query: params.get('q') ?? '',
    classes,
    sizes,
    scopes,
    inRegion: params.get('bolge') === '1',
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
  set('bolge', filters.inRegion ? '1' : undefined);
  set('mail', paramOf(EMAIL_PARAM, filters.email));
  set('yazi', filters.ready ? '1' : undefined);
  set('sira', paramOf(SORT_PARAM, filters.sort));
  return next;
}

export function activeFilterCount(filters: CompanyFilters): number {
  return Number(!!filters.query.trim()) + Number(filters.classes.length > 0) + Number(filters.sizes.length > 0) + Number(filters.scopes.length > 0) + Number(filters.inRegion) + Number(filters.email !== 'any') + Number(filters.ready);
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

function opportunityFilter(filters: CompanyFilters): ((o: HomeOpportunity) => boolean) | null {
  if (filters.email === 'any' && !filters.ready && !filters.scopes.length) return null;
  return (o) => (filters.email === 'any' || (filters.email === 'has') === hasEmail(o)) && (!filters.ready || draftReady(o)) && (!filters.scopes.length || filters.scopes.includes(scopeFilterOf(o)));
}

const newestAt = (company: HomeCompany) => [company.foundAt, ...company.opportunities.map((o) => o.foundAt)].reduce((latest, at) => (at > latest ? at : latest));

/**
 * Filtreler birlikte uygulanır (VE). Mail, yazı ve kapsam filtreleri fırsat düzeyindedir: firma, koşulu sağlayan
 * en az bir fırsatı varsa kalır ve yalnızca o fırsatlarıyla listelenir.
 */
export function filterCompanies(companies: HomeCompany[], filters: CompanyFilters): HomeCompany[] {
  const tokens = tokensOf(filters.query);
  const keepOpportunity = opportunityFilter(filters);
  const result: HomeCompany[] = [];
  for (const company of companies) {
    if (filters.classes.length && !filters.classes.includes(company.class)) continue;
    if (filters.sizes.length && !filters.sizes.includes(sizeBucketOf(company.employees))) continue;
    if (filters.inRegion && company.regionMatch !== 'yes') continue;
    if (tokens.length && !matchesAll(tokens, haystackOf(company))) continue;
    if (!keepOpportunity) {
      result.push(company);
      continue;
    }
    const opportunities = company.opportunities.filter(keepOpportunity);
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
