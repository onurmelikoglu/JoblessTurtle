import type { AddressFeatures } from './address-book';
import type { SendOutcome } from './learning';
import type { Sample } from './learning-model';

/**
 * Deneyim defterindeki kayıtların modellere girdiği biçim. Özellikler hem eğitimde (geçmiş kayıt) hem kestirimde
 * (henüz gönderilmemiş başvuru) aynı fonksiyonla üretilir; böylece iki taraf birbirinden kaymaz.
 */
export const LEARNED_MODELS = ['delivery', 'reply', 'interest'] as const;
export type LearnedModelName = (typeof LEARNED_MODELS)[number];

export const LEARNED_MODEL_LABELS: Record<LearnedModelName, string> = {
  delivery: 'Teslim: adres mail alıyor mu',
  reply: 'Yanıt: firma dönüş yapıyor mu',
  interest: 'İlgi: kullanıcı bu fırsata başvuruyor mu',
};

/** Adresin kendisinden kaynaklanan geri dönüşler; ek boyutu, dolu kutu ve içerik reddi adresin kalitesini göstermez. */
const ADDRESS_FAILURES = ['bad_address', 'closed_address', 'bad_domain', 'address_changed', 'bounce_other'];
/** Yanıt gelmemiş gönderim ancak bu kadar bekledikten sonra "yanıt yok" sayılır. */
export const REPLY_WINDOW_DAYS = 21;

const UNKNOWN = 'unknown';
const flag = (value: unknown) => (value ? 'yes' : 'no');
const text = (value: unknown) => (typeof value === 'string' && value ? value : UNKNOWN);

export function deliveryFeatures(a: Pick<AddressFeatures, 'kind' | 'local' | 'domainMatch' | 'sourceType' | 'verified'>): Sample['features'] {
  return { kind: a.kind, local: a.local, domainMatch: flag(a.domainMatch), sourceType: a.sourceType, verified: flag(a.verified) };
}

export function deliveryLabel(outcome: SendOutcome | null | undefined): 0 | 1 | null {
  if (!outcome) return null;
  if (outcome.bounced) return ADDRESS_FAILURES.includes(outcome.category) || outcome.dead ? 0 : null;
  return outcome.delivered ? 1 : null;
}

export interface ReplyContext {
  category?: string | null;
  intent?: string | null;
  kind?: string | null;
  employeeRange?: string | null;
  hasJob?: boolean | null;
  companyOrigin?: string | null;
}

/** Yalnızca gönderimden önce bilinen özellikler: model, henüz başvurulmamış firmaları sıralamak için kullanılır. */
export function replyFeatures(c: ReplyContext): Sample['features'] {
  return { category: text(c.category), intent: text(c.intent), kind: text(c.kind), employeeRange: text(c.employeeRange), hasJob: flag(c.hasJob), companyOrigin: text(c.companyOrigin) };
}

export function replyLabel(outcome: SendOutcome | null | undefined, ageDays: number): 0 | 1 | null {
  if (!outcome?.delivered || outcome.bounced) return null;
  if (outcome.replied) return 1;
  return ageDays >= REPLY_WINDOW_DAYS ? 0 : null;
}

export interface InterestContext {
  category?: string | null;
  titleMatch?: string | null;
  locationState?: string | null;
  employeeRange?: string | null;
  companyOrigin?: string | null;
  hasJob?: boolean | null;
}

export function interestFeatures(c: InterestContext): Sample['features'] {
  return { category: text(c.category), titleMatch: text(c.titleMatch), locationState: text(c.locationState), employeeRange: text(c.employeeRange), companyOrigin: text(c.companyOrigin), hasJob: flag(c.hasJob) };
}

const SOURCE_LABELS: Record<string, string> = {
  company_site: 'firmanın kendi sitesi',
  careers_page: 'kariyer sayfası',
  job_board: 'ilan siteleri',
  social: 'sosyal medya',
  directory: 'firma rehberleri',
  other_site: 'üçüncü taraf siteler',
};
const HINT_MIN_SAMPLES = 15;
const HINT_MIN_SPREAD = 0.08;

export interface RateRow {
  value: string;
  samples: number;
  rate: number;
}

/** Aynı özelliğin değerlerine göre olumlu oranı; yalnızca yeterince örneği olan değerler döner. */
export function ratesBy(samples: Sample[], feature: string, minSamples = HINT_MIN_SAMPLES): RateRow[] {
  const stats = new Map<string, { samples: number; positives: number }>();
  for (const s of samples) {
    const value = s.features[feature];
    if (value === undefined) continue;
    const entry = stats.get(value) ?? { samples: 0, positives: 0 };
    entry.samples++;
    entry.positives += s.label;
    stats.set(value, entry);
  }
  return [...stats]
    .filter(([, e]) => e.samples >= minSamples)
    .map(([value, e]) => ({ value, samples: e.samples, rate: e.positives / e.samples }))
    .sort((a, b) => b.rate - a.rate);
}

const percent = (rate: number) => `%${Math.round(rate * 100)}`;

/**
 * Adres aramasının istemine eklenen, kendi gönderimlerimizden çıkan ipucu: adresin bulunduğu yer ulaşma oranını
 * belirgin biçimde etkiliyorsa hangi kaynakların öne alınacağı söylenir. Fark küçükse ya da veri azsa ipucu üretilmez.
 */
export function contactSearchHints(deliverySamples: Sample[]): string[] {
  const rows = ratesBy(deliverySamples, 'sourceType').filter((r) => SOURCE_LABELS[r.value]);
  if (rows.length < 2 || rows[0].rate - rows[rows.length - 1].rate < HINT_MIN_SPREAD) return [];
  const list = rows.map((r) => `${SOURCE_LABELS[r.value]} ${percent(r.rate)} (${r.samples} gönderim)`).join(', ');
  return [`Bu sistemde gönderilen başvurularda adresin bulunduğu yere göre ulaşma oranı: ${list}. Adresi önce "${SOURCE_LABELS[rows[0].value]}" türünde bir sayfada ara ve doğrula; yalnızca "${SOURCE_LABELS[rows[rows.length - 1].value]}" türünde geçen adresi listenin sonuna yaz.`];
}

const DISCOVERY_MIN_REPLIES = 3;
const DISCOVERY_TOP = 3;

/** Keşif istemine eklenen ipucu: bu adayın başvurularına yanıt veren firmaların ortak sektörleri ve büyüklükleri. */
export function discoveryHints(replied: { sectors: string[]; employeeRange: string | null }[]): string[] {
  if (replied.length < DISCOVERY_MIN_REPLIES) return [];
  const count = (values: string[]) => {
    const counts = new Map<string, number>();
    for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
    return [...counts].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'tr')).slice(0, DISCOVERY_TOP);
  };
  const sectors = count(replied.flatMap((c) => [...new Set(c.sectors.map((s) => s.trim().toLocaleLowerCase('tr')).filter(Boolean))]));
  const sizes = count(replied.map((c) => c.employeeRange).filter((r): r is string => !!r));
  const parts = [sectors.length ? `sektör: ${sectors.map(([s, n]) => `${s} (${n})`).join(', ')}` : null, sizes.length ? `çalışan sayısı: ${sizes.map(([s, n]) => `${s} (${n})`).join(', ')}` : null].filter(Boolean);
  if (!parts.length) return [];
  return [`Bu adayın başvurularına şimdiye kadar yanıt veren ${replied.length} firmanın ortak özellikleri — ${parts.join('; ')}. Uygun adaylar arasında benzer firmalara öncelik ver.`];
}
