import type { NotificationClearRange } from '@/api/types';

/**
 * Bildirimler sayfasının süzgeçleri. Tarih-saat alanları `datetime-local` denetiminin değerini (tarayıcının saat
 * diliminde "YYYY-AA-GGTSS:DD") taşır; sunucuya ISO 8601 olarak gider.
 */
export interface NotificationFilters {
  query: string;
  from: string;
  to: string;
  unread: boolean;
  /** Hazır aralıklardan biri seçildiyse onun anahtarı; tarih elle değişince düşer. */
  preset: RangePreset | null;
}

export const EMPTY_FILTERS: NotificationFilters = { query: '', from: '', to: '', unread: false, preset: null };
export const SEARCH_DEBOUNCE_MS = 300;
export const PAGE_SIZE = 30;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export type RangePreset = '1h' | 'today' | '24h' | '7d';

export const RANGE_PRESETS: { key: RangePreset; label: string }[] = [
  { key: '1h', label: 'Son 1 saat' },
  { key: 'today', label: 'Bugün' },
  { key: '24h', label: 'Son 24 saat' },
  { key: '7d', label: 'Son 7 gün' },
];

const pad = (n: number) => String(n).padStart(2, '0');

/** Tarihi `datetime-local` değerine çevirir (tarayıcının saat dilimi, dakika duyarlılığı). */
export function toLocalInput(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function parseLocalInput(value: string): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Hazır aralığın başlangıcı; bitiş boş kalır (şu ana kadar). */
export function presetRange(preset: RangePreset, now: Date): Pick<NotificationFilters, 'from' | 'to' | 'preset'> {
  const start = {
    '1h': () => new Date(now.getTime() - HOUR),
    today: () => new Date(now.getFullYear(), now.getMonth(), now.getDate()),
    '24h': () => new Date(now.getTime() - DAY),
    '7d': () => new Date(now.getTime() - 7 * DAY),
  }[preset]();
  return { from: toLocalInput(start), to: '', preset };
}

/** Hazır aralık düğmesi: seçili olana yeniden basınca aralık kalkar. */
export function togglePreset(current: RangePreset | null, preset: RangePreset, now = new Date()): Pick<NotificationFilters, 'from' | 'to' | 'preset'> {
  return current === preset ? { from: '', to: '', preset: null } : presetRange(preset, now);
}

export function rangeError(filters: Pick<NotificationFilters, 'from' | 'to'>): string | null {
  const from = parseLocalInput(filters.from);
  const to = parseLocalInput(filters.to);
  return from && to && from > to ? 'Başlangıç, bitişten sonra olamaz.' : null;
}

export function hasActiveFilters(filters: NotificationFilters): boolean {
  return !!filters.query.trim() || !!filters.from || !!filters.to || filters.unread;
}

/**
 * Sunucuya giden sorgu. Bitiş dakika duyarlılığında seçildiği için o dakikanın sonuna uzatılır: 14:30'a kadar
 * denince 14:30:45'te gelen bildirim de listelenir.
 */
export function listParams(filters: NotificationFilters, cursor?: string): Record<string, string | number | boolean | undefined> {
  const from = parseLocalInput(filters.from);
  const to = parseLocalInput(filters.to);
  return {
    q: filters.query.trim() || undefined,
    from: from?.toISOString(),
    to: to ? new Date(to.getTime() + MINUTE - 1).toISOString() : undefined,
    unread: filters.unread || undefined,
    limit: PAGE_SIZE,
    cursor,
  };
}

/** Liste üstündeki sonuç sayısı; boş liste için boş durum paneli konuşur. */
export function resultSummary(total: number, filtered: boolean): string {
  return filtered ? `Filtreye uyan ${total} bildirim` : `${total} bildirim`;
}

export interface ClearOption {
  range: NotificationClearRange;
  label: string;
}

export const CLEAR_OPTIONS: ClearOption[] = [
  { range: '1h', label: 'Son 1 saat' },
  { range: '24h', label: 'Son 24 saat' },
  { range: '7d', label: 'Son 1 hafta' },
  { range: 'all', label: 'Tümü' },
];

const CLEAR_TEXT: Record<NotificationClearRange, { title: string; scope: string }> = {
  '1h': { title: 'Son 1 saatin bildirimleri silinsin mi?', scope: 'Son 1 saatte gelen bütün bildirimler' },
  '24h': { title: 'Son 24 saatin bildirimleri silinsin mi?', scope: 'Son 24 saatte gelen bütün bildirimler' },
  '7d': { title: 'Son 1 haftanın bildirimleri silinsin mi?', scope: 'Son 7 günde gelen bütün bildirimler' },
  all: { title: 'Tüm bildirimler silinsin mi?', scope: 'Bütün bildirimler' },
};

/** Onay penceresi silinecek kapsamı söyler; arama ve tarih süzgeci açıksa silmenin ondan bağımsız olduğunu da. */
export function clearConfirm(range: NotificationClearRange, filtered: boolean) {
  const { title, scope } = CLEAR_TEXT[range];
  const notes = [`${scope} silinir; okunmuş ya da okunmamış fark etmez.`, 'Bu işlem geri alınamaz. Telegram’a giden mesajlar etkilenmez.'];
  if (filtered) notes.push('Arama ve tarih filtresi silmeye uygulanmaz.');
  return { title, message: notes.join('\n'), confirmLabel: 'Sil', danger: true };
}

export function clearedMessage(deleted: number): string {
  return deleted ? `${deleted} bildirim silindi.` : 'Bu aralıkta silinecek bildirim yoktu.';
}
