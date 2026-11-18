/**
 * Otomatik başvuru ayarları ve "neye göre başvuruyor" özeti (/v1/home/auto-apply/*). Yalnızca tip; web arayüzü de
 * aynı dosyayı içe aktarır.
 */
import type { EmployeeRange } from '../domain/company-size';
import type { ReasonCode } from '../domain/policy';

export type AutoWorkMode = 'onsite' | 'hybrid' | 'remote';
export type AtsRewriteMode = 'fill_gaps' | 'evidence_only';
export type AtsCvLayout = 'original' | 'plain';
export type AtsMaxPages = 1 | 2;

export interface AutoApplySettings {
  autoSend: boolean;
  /** Günde en çok kaç ilana otomatik başvurulur. */
  dailyLimit: number;
  /** Yapay zekâ ilan aramasının aralığı (saat). */
  searchEveryHours: number;
  /** Boş: profildeki şehirler (konum kuralı); dolu: yalnızca bu şehirlerdeki ilanlar. */
  filterCities: string[];
  filterWorkModes: AutoWorkMode[];
  filterSizes: EmployeeRange[];
  includeUnknownWorkMode: boolean;
  includeUnknownSize: boolean;
  /** Rol uyumu (F) eşiği, 0-100. */
  fMin: number;
  /** Firma kalitesi (Q) eşiği, 0-100; 0 kapalı. */
  qMin: number;
  /** Firma bilgisi kapsam eşiği, 0-1; 0 kapalı. */
  coverageMin: number;
  companyCooldownDays: number;
  atsAutoImprove: boolean;
  /** Bu oranın altındaki CV düşük sayılır (yüzde). */
  atsThreshold: number;
  atsRewriteMode: AtsRewriteMode;
  /** İyileştirilmiş CV orijinal CV'nin tasarımıyla mı (fotoğraflı) yoksa sade ATS şablonuyla mı çizilir. */
  atsCvLayout: AtsCvLayout;
  /** İyileştirilmiş CV en fazla kaç sayfa olabilir; aşarsa kısaltılır. */
  atsMaxPages: AtsMaxPages;
}

export interface AutoApplyReasonCount {
  code: ReasonCode;
  label: string;
  count: number;
}

export interface AutoApplyThresholdPass {
  /** Açık ve hedef/yakın unvanlı (başvurulmamış) ilan sayısı. */
  open: number;
  f: number;
  q: number;
  coverage: number;
  /** Üç eşiği birden geçen. */
  all: number;
}

export interface AutoApplyExplain {
  /** Okunur kurallar: "Başlığı aradığın unvanlarla tam eşleşen ilanlar" gibi. */
  rules: string[];
  /** Son 7 günde otomatik başvurunun takıldığı nedenler, en sık önce. */
  reasons: AutoApplyReasonCount[];
  evaluated: number;
  passes: AutoApplyThresholdPass;
  sentToday: number;
  queued: number;
}

export interface AutoApplyOptions {
  /** Profildeki şehir seçimleri, önce. */
  profileCities: string[];
  /** Türkiye'nin 81 ili. */
  provinces: string[];
  employeeRanges: EmployeeRange[];
  searchIntervals: number[];
  /** Yönetici kaydederse ilan sitesi taraması aralığı da buna eşlenir (tüm kullanıcılar için). */
  canSetScraperInterval: boolean;
  scraperIntervalHours: number | null;
}

export interface AutoApplyView {
  settings: AutoApplySettings | null;
  /** Ayar yapılamıyorsa nedeni (ör. mail hesabı yok). */
  blocker: string | null;
  options: AutoApplyOptions;
  explain: AutoApplyExplain | null;
}
