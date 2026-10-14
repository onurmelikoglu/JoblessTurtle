/**
 * Yönetici ekranındaki "Öğrenme" bölümünün yanıt sözleşmesi. Web arayüzü bu dosyayı yalnızca tip olarak içe aktarır.
 */
import type { LearnedModelName } from '../domain/learning-features';
import type { FeatureEffect, InactiveReason } from '../domain/learning-model';
import type { IsoDate } from './wire';

export type { FeatureEffect, InactiveReason, LearnedModelName };

export interface LearnedModelSummary {
  name: LearnedModelName;
  label: string;
  /** Kişisel modellerde modelin ait olduğu çalışma alanının adı; ortak modellerde null. */
  scope: string | null;
  trainedAt: IsoDate | null;
  active: boolean;
  inactiveReason: InactiveReason | null;
  samples: number;
  positives: number;
  baseRate: number;
  /** Çapraz doğrulamada temel orana göre iyileşme (0 = fark yok). */
  gain: number;
  auc: number | null;
  effects: FeatureEffect[];
}

export interface WeeklyDelivery {
  /** Haftanın pazartesi günü (YYYY-AA-GG, İstanbul). */
  week: string;
  sent: number;
  delivered: number;
  bounced: number;
  replied: number;
  /** Sonucu henüz kesinleşmemiş gönderim (ulaştı bilgisi geri dönüş gelmeden 72 saat geçince kesinleşir). */
  pending: number;
  /** Gönderilenler içinde geri dönenlerin oranı. */
  bounceRate: number;
}

export interface PromptVariant {
  kind: string;
  label: string;
  /** İsteme geçmiş sonuçlardan öğrenilen ipuçları eklenmiş miydi. */
  hints: boolean;
  runs: number;
  /** Aramanın işe yarama oranı (ör. adres aramasında yeni gönderilebilir adres bulunması). */
  successRate: number;
}

export interface LearningOverview {
  events: { kind: string; label: string; total: number; resolved: number }[];
  models: LearnedModelSummary[];
  weekly: WeeklyDelivery[];
  hints: { contactSearch: string[] };
  promptVariants: PromptVariant[];
  /** Dışa aktarılabilecek (istemi ve çıktısı saklı) kayıt sayısı. */
  exportable: number;
  trainedAt: IsoDate | null;
}
