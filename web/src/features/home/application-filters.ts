import type { HomeApplication } from '@/api/types';
import { toDate } from '@/lib/format';
import { haystack, matchesAll, tokensOf } from '@/lib/text';
import { BUCKET_INFO, bucketOf, type DeliveryBucket } from './model';

export type ApplicationSort = 'newest' | 'oldest' | 'company';
export type DateRange = 'all' | 'today' | 'week' | 'month';

export interface ApplicationFilters {
  query: string;
  bucket: DeliveryBucket | null;
  range: DateRange;
  sort: ApplicationSort;
}

export const DEFAULT_APPLICATION_FILTERS: ApplicationFilters = { query: '', bucket: null, range: 'all', sort: 'newest' };
export const RANGE_LABELS: Record<DateRange, string> = { all: 'Tüm zamanlar', today: 'Son 24 saat', week: 'Son 7 gün', month: 'Son 30 gün' };
export const APPLICATION_SORT_LABELS: Record<ApplicationSort, string> = { newest: 'En yeni', oldest: 'En eski', company: 'Firma adı (A-Z)' };

const DAY_MS = 86_400_000;
const RANGE_DAYS: Record<DateRange, number | null> = { all: null, today: 1, week: 7, month: 30 };

const time = (a: HomeApplication) => toDate(a.sentAt)?.getTime() ?? 0;

export function filterApplications(applications: HomeApplication[], filters: ApplicationFilters, now = Date.now()): HomeApplication[] {
  const tokens = tokensOf(filters.query);
  const days = RANGE_DAYS[filters.range];
  const result = applications.filter((a) => {
    const bucket = bucketOf(a);
    if (filters.bucket && bucket !== filters.bucket) return false;
    if (days !== null && now - time(a) > days * DAY_MS) return false;
    return tokens.length === 0 || matchesAll(tokens, haystack([a.company, a.title, a.toEmail, a.delivery?.label, a.reasonLabel, BUCKET_INFO[bucket].label]));
  });
  if (filters.sort === 'company') return result.sort((a, b) => a.company.localeCompare(b.company, 'tr') || time(b) - time(a));
  return result.sort((a, b) => (filters.sort === 'newest' ? time(b) - time(a) : time(a) - time(b)));
}
