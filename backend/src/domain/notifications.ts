import { fold } from './text';

/** Geçmişi temizleme kapsamları: son 1 saat, son 24 saat, son 7 gün ya da tümü. */
export const NOTIFICATION_CLEAR_RANGES = ['1h', '24h', '7d', 'all'] as const;
export type NotificationClearRange = (typeof NOTIFICATION_CLEAR_RANGES)[number];

const HOUR_MS = 3_600_000;
const CLEAR_RANGE_MS: Record<NotificationClearRange, number | null> = { '1h': HOUR_MS, '24h': 24 * HOUR_MS, '7d': 7 * 24 * HOUR_MS, all: null };

/** Kapsamın başlangıcı; "tümü" için null (zaman sınırı yok). */
export function clearSince(range: NotificationClearRange, now = new Date()): Date | null {
  const span = CLEAR_RANGE_MS[range];
  return span === null ? null : new Date(now.getTime() - span);
}

/**
 * Listeleme penceresi: istenen başlangıç saklama sınırından (30 gün) eskiyse sınıra çekilir; bitiş olduğu gibi kalır.
 * Böylece eski tarihli bir filtre silinmeyi bekleyen kayıtları göstermez.
 */
export function listWindow(cutoff: Date, from?: Date, to?: Date): { gte: Date; lte?: Date } {
  const gte = from && from > cutoff ? from : cutoff;
  return to ? { gte, lte: to } : { gte };
}

const MAX_SEARCH_TOKENS = 8;

/**
 * Arama metni sadeleştirilmiş sözcüklere bölünür (büyük/küçük harf ve Türkçe harf farkı gözetilmez); her sözcük
 * başlıkta ya da gövdede geçmelidir. Sözcükler yalnızca [a-z0-9@.+] içerir, LIKE kalıbında kaçış gerektirmez.
 */
export function searchTokens(query: string | null | undefined): string[] {
  return [...new Set(fold(query).split(' ').filter(Boolean))].slice(0, MAX_SEARCH_TOKENS);
}

/**
 * Veritabanı tarafında `fold` ile aynı sadeleştirme: `translate(metin, FOLD_FROM, FOLD_TO)` ardından `lower`.
 * Büyük I önce ı'ya, sonra i'ye döner; sık görülen aksanlı Latin harfleri de sade karşılığına iner.
 */
const FOLD_SOURCES: Record<string, string> = { i: 'İIıÎîÍíÌìÏï', s: 'Şş', g: 'Ğğ', u: 'ÜüÛûÚúÙù', o: 'ÖöÓóÒòÔô', c: 'Çç', a: 'ÂâÁáÀàÄä', e: 'ÉéÈèÊêËë', n: 'Ññ' };
export const FOLD_FROM = Object.values(FOLD_SOURCES).join('');
export const FOLD_TO = Object.entries(FOLD_SOURCES)
  .map(([plain, sources]) => plain.repeat(sources.length))
  .join('');

/** İmleç: son kaydın oluşturulma anı ve kimliği. Kayıt silinse bile sayfalama kaldığı yerden sürer. */
export function encodeNotificationCursor(row: { createdAt: Date; id: string }): string {
  return `${row.createdAt.getTime()}_${row.id}`;
}

export function decodeNotificationCursor(cursor: string): { createdAt: Date; id: string } | null {
  const match = /^(\d{1,15})_([A-Za-z0-9-]{1,40})$/.exec(cursor);
  return match ? { createdAt: new Date(Number(match[1])), id: match[2] } : null;
}
