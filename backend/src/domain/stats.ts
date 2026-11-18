/**
 * Kişisel istatistikler: gönderilen başvurulardan huni, boyutlara göre yanıt oranı, haftalık gidişat ve gönderim
 * saati önerisi. Saf hesaplama; veri hizmet katmanında toplanır.
 */
export interface StatAttempt {
  sentAt: Date;
  failed: boolean;
  replied: boolean;
  interview: boolean;
  offer: boolean;
  sector: string | null;
  size: string | null;
  channel: 'email' | 'form';
  language: 'tr' | 'en';
  intent: 'job' | 'general';
  source: string;
}

export interface FunnelStep {
  key: 'sent' | 'delivered' | 'replied' | 'interview' | 'offer';
  label: string;
  count: number;
}

export interface RateRow {
  key: string;
  label: string;
  sent: number;
  replied: number;
  rate: number;
}

export interface WeekRow {
  week: string;
  sent: number;
  failed: number;
  replied: number;
}

export interface SendTimeCell {
  weekday: number;
  hour: number;
  sent: number;
  replied: number;
}

export interface SendTimeSuggestion {
  weekday: number;
  fromHour: number;
  toHour: number;
  rate: number;
  sent: number;
}

/** Öneri ancak bu kadar yanıt birikince yapılır; daha azıyla saat farkı rastlantıdan ayırt edilemez. */
export const MIN_REPLIES_FOR_SUGGESTION = 30;
/** Bir dilimin öneri adayı olabilmesi için en az gönderim. */
export const MIN_SENT_PER_SLOT = 5;
/** Oran tablolarında yeterli örneği olmayan satırlar "Diğer"e katılır. */
export const MIN_SENT_PER_ROW = 3;
const SLOT_HOURS = 3;

const ratio = (part: number, whole: number) => (whole ? Math.round((part / whole) * 1000) / 1000 : 0);

export function funnel(attempts: StatAttempt[]): FunnelStep[] {
  const count = (fn: (a: StatAttempt) => boolean) => attempts.filter(fn).length;
  return [
    { key: 'sent', label: 'Gönderildi', count: attempts.length },
    { key: 'delivered', label: 'Ulaştı', count: count((a) => !a.failed) },
    { key: 'replied', label: 'Yanıt geldi', count: count((a) => a.replied) },
    { key: 'interview', label: 'Mülâkat', count: count((a) => a.interview) },
    { key: 'offer', label: 'Teklif', count: count((a) => a.offer) },
  ];
}

/** Boyuta göre yanıt oranı; en çok gönderilen önce, az örnekli satırlar "Diğer"de toplanır. */
export function ratesBy(attempts: StatAttempt[], keyOf: (a: StatAttempt) => string | null, labelOf: (key: string) => string = (k) => k): RateRow[] {
  const groups = new Map<string, { sent: number; replied: number }>();
  for (const a of attempts) {
    const key = keyOf(a) ?? 'unknown';
    const g = groups.get(key) ?? { sent: 0, replied: 0 };
    g.sent++;
    if (a.replied) g.replied++;
    groups.set(key, g);
  }
  const rows: RateRow[] = [];
  const other = { sent: 0, replied: 0 };
  for (const [key, g] of groups) {
    if (g.sent < MIN_SENT_PER_ROW || key === 'unknown') {
      other.sent += g.sent;
      other.replied += g.replied;
      continue;
    }
    rows.push({ key, label: labelOf(key), sent: g.sent, replied: g.replied, rate: ratio(g.replied, g.sent) });
  }
  rows.sort((a, b) => b.sent - a.sent || a.label.localeCompare(b.label, 'tr'));
  if (other.sent) rows.push({ key: 'other', label: 'Diğer / bilinmiyor', sent: other.sent, replied: other.replied, rate: ratio(other.replied, other.sent) });
  return rows;
}

/** ISO hafta başı (pazartesi), Türkiye saatine göre; "2026-11-09" biçiminde. */
export function weekOf(date: Date, offsetMinutes = 180): string {
  const local = new Date(date.getTime() + offsetMinutes * 60_000);
  const day = (local.getUTCDay() + 6) % 7;
  const monday = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - day));
  return monday.toISOString().slice(0, 10);
}

export function weekly(attempts: StatAttempt[]): WeekRow[] {
  const weeks = new Map<string, WeekRow>();
  for (const a of attempts) {
    const week = weekOf(a.sentAt);
    const row = weeks.get(week) ?? { week, sent: 0, failed: 0, replied: 0 };
    row.sent++;
    if (a.failed) row.failed++;
    if (a.replied) row.replied++;
    weeks.set(week, row);
  }
  return [...weeks.values()].sort((a, b) => (a.week < b.week ? -1 : 1));
}

/** Gün (0 = pazartesi) × saat, Türkiye saatine göre gönderim ve yanıt sayıları. */
export function sendTimeGrid(attempts: StatAttempt[], offsetMinutes = 180): SendTimeCell[] {
  const cells = new Map<string, SendTimeCell>();
  for (const a of attempts) {
    const local = new Date(a.sentAt.getTime() + offsetMinutes * 60_000);
    const weekday = (local.getUTCDay() + 6) % 7;
    const hour = local.getUTCHours();
    const key = `${weekday}:${hour}`;
    const cell = cells.get(key) ?? { weekday, hour, sent: 0, replied: 0 };
    cell.sent++;
    if (a.replied) cell.replied++;
    cells.set(key, cell);
  }
  return [...cells.values()].sort((a, b) => a.weekday - b.weekday || a.hour - b.hour);
}

/**
 * En yüksek yanıt oranlı üç saatlik gönderim dilimi. Toplam yanıt MIN_REPLIES_FOR_SUGGESTION'ın altındaysa ya da
 * hiçbir dilim yeterli gönderim almadıysa öneri yapılmaz (null).
 */
export function suggestSendTime(grid: SendTimeCell[]): SendTimeSuggestion | null {
  const totalReplies = grid.reduce((n, c) => n + c.replied, 0);
  if (totalReplies < MIN_REPLIES_FOR_SUGGESTION) return null;
  const slots = new Map<string, SendTimeSuggestion>();
  for (const c of grid) {
    const fromHour = Math.floor(c.hour / SLOT_HOURS) * SLOT_HOURS;
    const key = `${c.weekday}:${fromHour}`;
    const s = slots.get(key) ?? { weekday: c.weekday, fromHour, toHour: fromHour + SLOT_HOURS, rate: 0, sent: 0 };
    s.sent += c.sent;
    s.rate += c.replied;
    slots.set(key, s);
  }
  const ranked = [...slots.values()]
    .filter((s) => s.sent >= MIN_SENT_PER_SLOT)
    .map((s) => ({ ...s, rate: ratio(s.rate, s.sent) }))
    .sort((a, b) => b.rate - a.rate || b.sent - a.sent);
  return ranked[0] ?? null;
}
