const ZONE = 'Europe/Istanbul';
const dateTime = new Intl.DateTimeFormat('tr-TR', { timeZone: ZONE, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const dateOnly = new Intl.DateTimeFormat('tr-TR', { timeZone: ZONE, day: 'numeric', month: 'short', year: 'numeric' });
const timeOnly = new Intl.DateTimeFormat('tr-TR', { timeZone: ZONE, hour: '2-digit', minute: '2-digit' });
const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export type DateInput = string | Date | null | undefined;

export function toDate(value: DateInput): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

const formatWith = (formatter: Intl.DateTimeFormat) => (value: DateInput) => {
  const date = toDate(value);
  return date ? formatter.format(date) : '-';
};

export const fmtDateTime = formatWith(dateTime);
export const fmtDate = formatWith(dateOnly);
export const fmtTime = formatWith(timeOnly);

export function fmtAgo(value: DateInput, now = Date.now()): string {
  const date = toDate(value);
  if (!date) return '-';
  const diff = now - date.getTime();
  if (diff < MINUTE) return 'az önce';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} dk önce`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} sa önce`;
  return `${Math.floor(diff / DAY)} gün önce`;
}

/** Gelecekteki bir an: "birazdan", "12 dk sonra", "yarın 03:00". Geçmişte kaldıysa "birazdan" döner. */
export function fmtUntil(value: DateInput, now = Date.now()): string {
  const date = toDate(value);
  if (!date) return '-';
  const diff = date.getTime() - now;
  if (diff < MINUTE) return 'birazdan';
  if (diff < HOUR) return `${Math.ceil(diff / MINUTE)} dk sonra`;
  const today = dayKey.format(new Date(now));
  const target = dayKey.format(date);
  if (target === today) return `bugün ${timeOnly.format(date)}`;
  if (target === dayKey.format(new Date(now + DAY))) return `yarın ${timeOnly.format(date)}`;
  return dateTime.format(date);
}

export function daysSince(value: DateInput, now = Date.now()): number | null {
  const date = toDate(value);
  return date ? Math.floor((now - date.getTime()) / DAY) : null;
}

export function fmtBytes(value: number | null | undefined): string {
  const n = value ?? 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function fmtCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return `${n}`;
}

export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}
