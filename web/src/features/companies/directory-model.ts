import type { DirectoryApplication, DirectoryCompany, DirectoryJob } from '@/api/types';
import { daysSince } from '@/lib/format';
import { haystack, matchesAll, tokensOf } from '@/lib/text';
import type { Tone } from '@/ui/tones';

export const DIRECTORY_FILTERS = ['tum', 'basvurdum', 'yeni-ilan', 'yanit-var', 'basvurmadim'] as const;
export type DirectoryFilter = (typeof DIRECTORY_FILTERS)[number];
export const DIRECTORY_SORTS = ['son-basvuru', 'son-ilan', 'ad'] as const;
export type DirectorySort = (typeof DIRECTORY_SORTS)[number];

export const FILTER_LABELS: Record<DirectoryFilter, string> = {
  tum: 'Tümü',
  basvurdum: 'Başvurduklarım',
  'yeni-ilan': 'Başvurudan sonra yeni ilan',
  'yanit-var': 'Yanıt gelenler',
  basvurmadim: 'Hiç başvurmadıklarım',
};

export const SORT_LABELS: Record<DirectorySort, string> = { 'son-basvuru': 'Son başvuru', 'son-ilan': 'Son ilan', ad: 'Firma adı (A-Z)' };

export interface DirectoryView {
  query: string;
  filter: DirectoryFilter;
  sort: DirectorySort;
}

const isOf = <T extends string>(values: readonly T[], value: string | null, fallback: T): T => (values as readonly string[]).includes(value ?? '') ? (value as T) : fallback;

export function parseView(params: URLSearchParams): DirectoryView {
  return { query: params.get('q') ?? '', filter: isOf(DIRECTORY_FILTERS, params.get('durum'), 'tum'), sort: isOf(DIRECTORY_SORTS, params.get('sira'), 'son-basvuru') };
}

export function writeView(params: URLSearchParams, view: DirectoryView): URLSearchParams {
  const next = new URLSearchParams(params);
  const set = (key: string, value: string | undefined) => (value ? next.set(key, value) : next.delete(key));
  set('q', view.query || undefined);
  set('durum', view.filter === 'tum' ? undefined : view.filter);
  set('sira', view.sort === 'son-basvuru' ? undefined : view.sort);
  return next;
}

const PASSES: Record<DirectoryFilter, (c: DirectoryCompany) => boolean> = {
  tum: () => true,
  basvurdum: (c) => c.applications > 0,
  'yeni-ilan': (c) => c.newSinceApply > 0,
  'yanit-var': (c) => c.replies > 0,
  basvurmadim: (c) => c.applications === 0,
};

const time = (iso: string | null) => (iso ? Date.parse(iso) : 0);

/** Son başvuru sırasında hiç başvurulmamış firmalar en yeni ilanlarına göre en sona gelir. */
const COMPARE: Record<DirectorySort, (a: DirectoryCompany, b: DirectoryCompany) => number> = {
  'son-basvuru': (a, b) => time(b.lastAppliedAt) - time(a.lastAppliedAt) || time(b.lastJobAt) - time(a.lastJobAt),
  'son-ilan': (a, b) => time(b.lastJobAt) - time(a.lastJobAt),
  ad: (a, b) => a.name.localeCompare(b.name, 'tr'),
};

export function filterDirectory(companies: DirectoryCompany[], view: DirectoryView): DirectoryCompany[] {
  const tokens = tokensOf(view.query);
  return companies
    .filter((c) => PASSES[view.filter](c) && (!tokens.length || matchesAll(tokens, haystack([c.name, ...c.aliases, ...c.cities, ...c.sectors, c.website]))))
    .sort(COMPARE[view.sort]);
}

/** "12 gün önce başvuruldu" gibi; hiç başvurulmadıysa null. */
export function lastApplyText(lastAppliedAt: string | null, now = Date.now()): string | null {
  const days = daysSince(lastAppliedAt, now);
  if (days === null) return null;
  return days === 0 ? 'Bugün başvuruldu' : `${days} gün önce başvuruldu`;
}

export const JOB_STATUS: Record<string, { label: string; tone: Tone }> = {
  open: { label: 'Açık', tone: 'good' },
  unknown: { label: 'Doğrulanmadı', tone: 'neutral' },
  stale: { label: 'Doğrulanamadı', tone: 'warn' },
  closed: { label: 'Kapandı', tone: 'neutral' },
};

export const jobStatus = (job: Pick<DirectoryJob, 'status'>) => JOB_STATUS[job.status] ?? { label: job.status, tone: 'neutral' as Tone };

const OUTCOME: Record<string, { label: string; tone: Tone }> = {
  interview: { label: 'Görüşme', tone: 'good' },
  offer: { label: 'Teklif', tone: 'good' },
  rejection: { label: 'Olumsuz', tone: 'bad' },
  no_response: { label: 'Yanıt yok', tone: 'neutral' },
};

const STATE: Record<string, { label: string; tone: Tone }> = {
  queued: { label: 'Sırada', tone: 'warn' },
  sending: { label: 'Sırada', tone: 'warn' },
  provider_accepted: { label: 'Gönderildi', tone: 'info' },
  submission_unknown: { label: 'Kontrol ediliyor', tone: 'warn' },
  replied: { label: 'Yanıt geldi', tone: 'good' },
  bounced: { label: 'İletilemedi', tone: 'bad' },
  failed_confirmed: { label: 'Gönderilemedi', tone: 'bad' },
  blocked: { label: 'Gönderilemedi', tone: 'bad' },
  outcome_recorded: { label: 'Sonuçlandı', tone: 'neutral' },
};

export function applicationStatus(a: Pick<DirectoryApplication, 'state' | 'outcome' | 'replyCount'>): { label: string; tone: Tone } {
  if (a.outcome && OUTCOME[a.outcome]) return OUTCOME[a.outcome];
  if (a.replyCount > 0 && a.state === 'provider_accepted') return STATE.replied;
  return STATE[a.state] ?? { label: a.state, tone: 'neutral' };
}

const WORK_MODE: Record<string, string> = { onsite: 'Yerinde', hybrid: 'Hibrit', remote: 'Uzaktan' };
export const workModeText = (mode: string) => WORK_MODE[mode] ?? null;

const MESSAGE_CATEGORY: Record<string, string> = {
  interview: 'Görüşme daveti',
  rejection: 'Olumsuz yanıt',
  human_reply: 'Yanıt',
  autoresponder: 'Otomatik yanıt',
  auto_reply: 'Otomatik yanıt',
  bounce: 'İletilemedi',
  do_not_contact: 'İletişim istemiyor',
};
export const messageCategory = (category: string | null) => (category ? (MESSAGE_CATEGORY[category] ?? 'Yanıt') : null);
