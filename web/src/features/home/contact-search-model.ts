import type { ContactRetryPlan, ContactSearchSummary, HomeAddressSearch } from '@/api/types';
import { fmtAgo, fmtDate, toDate } from '@/lib/format';

export const RETRY_PLAN_ORDER: ContactRetryPlan[] = ['often', 'normal', 'rare'];
export const RETRY_PLAN_LABEL: Record<ContactRetryPlan, string> = { often: 'Sık', normal: 'Normal', rare: 'Seyrek' };

/** "7 gün sonra, olmazsa 30 gün, sonra 90 günde bir" */
export function planDescription(days: number[]): string {
  const [first, second, rest] = days;
  return `İlk sonuçsuz aramadan ${first} gün sonra, olmazsa ${second} gün sonra, sonra ${rest} günde bir yeniden aranır.`;
}

/** Günlük Opus hakkıyla sıradaki firmaların kaç günde biteceği. */
export function opusQueueDays(summary: Pick<ContactSearchSummary, 'awaitingOpus'>, dailyLimit: number): number {
  return dailyLimit > 0 ? Math.ceil(summary.awaitingOpus / dailyLimit) : 0;
}

export function summaryLine(summary: ContactSearchSummary, settings: { opusRetry: boolean; opusDailyLimit: number }): string[] {
  const lines = [`Açık fırsatı olup mail adresi bulunamayan ${summary.withoutAddress} firma var; bunlardan ${summary.dueNow} tanesinin bekleme süresi doldu, bir sonraki aramada yeniden aranacak.`];
  if (settings.opusRetry && summary.awaitingOpus > 0) {
    lines.push(`${summary.awaitingOpus} firma hiç Opus ile aranmadı; her sabah ${settings.opusDailyLimit} tanesi Opus ile aranır (yaklaşık ${opusQueueDays(summary, settings.opusDailyLimit)} günde biter).`);
  }
  if (settings.opusRetry) lines.push(`Bugün Opus ile ${summary.opusUsedToday}/${settings.opusDailyLimit} arama yapıldı.`);
  return lines;
}

/** Firma kartında adres bulunamadığında son aramanın özeti; hiç aranmadıysa ya da adres bulunduysa null. */
export function addressSearchNote(search: HomeAddressSearch | null, now = Date.now()): string | null {
  if (!search || search.found) return null;
  const parts = [`${fmtAgo(search.searchedAt, now)} arandı${search.emptyStreak > 1 ? `, art arda ${search.emptyStreak}. sonuçsuz arama` : ''}`];
  if (search.opusAt) parts.push('Opus ile de arandı');
  const next = toDate(search.nextAt);
  if (next) parts.push(next.getTime() <= now ? 'sonraki aramada yeniden aranacak' : `${fmtDate(next)} tarihinde kendiliğinden yeniden aranacak`);
  return parts.join(' · ');
}

/** Firma hiç Opus ile aranmadıysa kartta "Opus ile ara" önerilir. */
export function canAskOpus(search: HomeAddressSearch | null): boolean {
  return !!search && !search.found && !search.opusAt;
}
