import type { FeatureEffect, InactiveReason, LearnedModelSummary, WeeklyDelivery } from '@/api/types';
import { fmtDate } from '@/lib/format';

const INACTIVE_TEXT: Record<InactiveReason, string> = {
  few_samples: 'Yeterli örnek birikmedi; kullanılmıyor',
  few_of_one_outcome: 'Sonuçlardan biri henüz çok az görüldü; kullanılmıyor',
  no_gain: 'Denenmemiş örneklerde temel orandan iyi tahmin edemiyor; kullanılmıyor',
};

const FEATURE_LABELS: Record<string, string> = {
  kind: 'Adres türü',
  local: 'Adresin başı',
  domainMatch: 'Alan adı firmayla eşleşiyor',
  sourceType: 'Adresin bulunduğu yer',
  verified: 'Doğrulanmış adres',
  category: 'Fırsat türü',
  intent: 'Başvuru türü',
  employeeRange: 'Çalışan sayısı',
  hasJob: 'İlana başvuru',
  companyOrigin: 'Firmanın geldiği yer',
  titleMatch: 'Unvan eşleşmesi',
  locationState: 'Konum',
};

const VALUE_LABELS: Record<string, string> = {
  yes: 'evet',
  no: 'hayır',
  unknown: 'bilinmiyor',
  official_hr: 'İK adresi',
  job_apply: 'ilandaki başvuru adresi',
  general: 'genel iletişim',
  named_recruiter: 'işe alım çalışanı',
  strong_hr: 'ik@, kariyer@ gibi',
  hr: 'İK ile ilgili',
  person: 'kişi adı',
  other: 'diğer',
  company_site: 'firmanın kendi sitesi',
  careers_page: 'kariyer sayfası',
  other_site: 'üçüncü taraf site',
  job_board: 'ilan sitesi',
  social: 'sosyal medya',
  directory: 'firma rehberi',
  target_open: 'açık ilan',
  adjacent_open: 'yakın rol',
  needs_confirmation: 'teyit bekleyen ilan',
  past_closed: 'kapanmış ilan',
  sector_target: 'potansiyel firma',
  not_found: 'ilanı olmayan firma',
  general_intent: 'açık başvuru',
  job_application: 'ilan başvurusu',
  intent_after_closed: 'kapanmış ilan sonrası',
  discovery: 'keşif',
  catalog: 'ortak liste',
  manual: 'elle eklendi',
  excel: 'içe aktarıldı',
  exact: 'birebir',
  adjacent: 'yakın',
  primary: 'tercih edilen bölge',
  conditional: 'yakın bölge',
  remote: 'uzaktan',
  outside: 'bölge dışı',
};

export const percent = (rate: number) => `%${Math.round(rate * 100)}`;
const decimal = (value: number) => value.toFixed(2).replace('.', ',');

/** Modelin tek satırlık durumu: kullanılıyorsa ne kadar iyi olduğu, kullanılmıyorsa nedeni. */
export function modelStatus(model: LearnedModelSummary): string {
  const size = `${model.samples} örnek`;
  if (!model.active) return `${INACTIVE_TEXT[model.inactiveReason ?? 'few_samples']} · ${size}`;
  const parts = ['Kullanılıyor', size, `temel oran ${percent(model.baseRate)}`];
  if (model.auc !== null) parts.push(`sıralama isabeti ${decimal(model.auc)}`);
  parts.push(`temel orana göre ${percent(model.gain)} daha iyi`);
  return parts.join(' · ');
}

export const modelTitle = (model: LearnedModelSummary) => (model.scope ? `${model.label} (${model.scope})` : model.label);

/** "Adresin bulunduğu yer: üçüncü taraf site — %40 (90 örnek)". */
export function effectText(effect: FeatureEffect): string {
  return `${FEATURE_LABELS[effect.feature] ?? effect.feature}: ${VALUE_LABELS[effect.value] ?? effect.value} — ${percent(effect.rate)} (${effect.samples} örnek)`;
}

/** Oranı modelin temel oranının altında kalan değerler uyarı, üstündekiler olumlu tonda gösterilir. */
export const effectTone = (effect: FeatureEffect, baseRate: number) => (effect.rate < baseRate ? 'bad' : 'good') as 'bad' | 'good';

export const weekLabel = (row: WeeklyDelivery) => `${fmtDate(`${row.week}T12:00:00+03:00`)} haftası`;
export const bounceText = (row: WeeklyDelivery) => percent(row.bounceRate);
