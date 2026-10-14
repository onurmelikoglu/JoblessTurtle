import { DateTime } from 'luxon';

export const TZ = 'Europe/Istanbul';

export function istanbulDay(date: Date = new Date()): string {
  return DateTime.fromJSDate(date).setZone(TZ).toFormat('yyyy-LL-dd');
}

export function istanbulNow(date: Date = new Date()): DateTime {
  return DateTime.fromJSDate(date).setZone(TZ);
}

/** "09:00" → dakika */
export function hhmmToMinutes(v: string): number {
  const [h, m] = v.split(':').map((x) => parseInt(x, 10));
  return (h || 0) * 60 + (m || 0);
}

/**
 * Gönderim penceresi: pencere içindeyse şimdi, değilse bir sonraki uygun başlangıç.
 * days: ISO hafta günü 1=Pazartesi … 7=Pazar.
 */
/** Ertesi günün (İstanbul) ilk gönderim penceresi; bugünün kalan saatleri atlanır. */
export function nextDaySendSlot(now: Date, start: string, end: string, days: number[]): Date {
  return nextSendSlot(istanbulNow(now).plus({ days: 1 }).startOf('day').toJSDate(), start, end, days);
}

export function nextSendSlot(now: Date, start: string, end: string, days: number[]): Date {
  let dt = istanbulNow(now);
  const s = hhmmToMinutes(start);
  const e = hhmmToMinutes(end);
  for (let i = 0; i < 8; i++) {
    const minutes = dt.hour * 60 + dt.minute;
    const dayOk = days.length === 0 || days.includes(dt.weekday);
    if (dayOk && i === 0 && minutes >= s && minutes < e) return now;
    if (dayOk && (i > 0 || minutes < s)) {
      return dt.set({ hour: Math.floor(s / 60), minute: s % 60, second: 0, millisecond: 0 }).toJSDate();
    }
    dt = dt.plus({ days: 1 }).startOf('day');
  }
  return now;
}

/** İş günü ekleme (Cumartesi/Pazar atlanır). */
export function addBusinessDays(from: Date, days: number): Date {
  let dt = istanbulNow(from);
  let added = 0;
  while (added < days) {
    dt = dt.plus({ days: 1 });
    if (dt.weekday <= 5) added++;
  }
  return dt.toJSDate();
}
