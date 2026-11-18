import type { IsoDate } from './wire';

export type ContactRetryPlan = 'often' | 'normal' | 'rare';

export interface ContactSearchSettingsView {
  retryPlan: ContactRetryPlan;
  opusRetry: boolean;
  opusDailyLimit: number;
  retryOnNewInfo: boolean;
}

export interface ContactSearchSummary {
  /** Açık fırsatı olup gönderilebilir adresi bulunmayan firmalar. */
  withoutAddress: number;
  /** Bunlardan aranmış ama hiç Opus ile aranmamış olanlar (günlük Opus taramasının sırası). */
  awaitingOpus: number;
  /** Bugün Opus ile yapılan adres araması. */
  opusUsedToday: number;
  /** Takvime göre bekleme süresi dolmuş, bir sonraki aramada yeniden aranacak firmalar. */
  dueNow: number;
}

export interface ContactSearchView {
  settings: ContactSearchSettingsView;
  /** Takvimlerin gün listesi: ilk, ikinci ve sonraki sonuçsuz aramadan sonra beklenen günler. */
  plans: Record<ContactRetryPlan, number[]>;
  maxOpusDailyLimit: number;
  summary: ContactSearchSummary;
}

/** Firmanın son adres araması; hiç aranmadıysa null. */
export interface HomeAddressSearch {
  searchedAt: IsoDate;
  /** Arama sonrası gönderilebilir adres var mı. */
  found: boolean;
  /** Art arda sonuçsuz arama sayısı. */
  emptyStreak: number;
  /** Bulunamadıysa kendiliğinden yeniden aranacağı an. */
  nextAt: IsoDate | null;
  opusAt: IsoDate | null;
}
