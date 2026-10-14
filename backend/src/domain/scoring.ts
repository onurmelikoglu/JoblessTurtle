/**
 * Firma kalite puanı (Q) ve rol uyumu (F) — doküman §5.
 * Q: 0–100, açıklanabilir sıralama önerisidir; finansal güç ölçümü değildir.
 * Bilinmeyen boyut puana katkı vermez; coverage ayrıca gösterilir ve kalan alanlar normalize edilmez.
 */

export const Q_DIMENSIONS = ['customer', 'campaign', 'reputation', 'service_fit', 'production'] as const;
export type QDimension = (typeof Q_DIMENSIONS)[number];

export const DEFAULT_Q_WEIGHTS: Record<QDimension, number> = {
  customer: 35,
  campaign: 25,
  reputation: 15,
  service_fit: 15,
  production: 10,
};

export const Q_LABELS: Record<QDimension, string> = {
  customer: 'Müşteri profili',
  campaign: 'Kampanya ve üretim',
  reputation: 'Bağımsız itibar',
  service_fit: 'Hizmet uyumu',
  production: 'Üretim yapısı',
};

export type DimScore = 0 | 0.5 | 1 | null;

export interface EvidenceLike {
  id: string;
  dimension: string;
  scope: string; // local | global | unknown
  claimType: string;
  confidence: string; // low | medium | high
  evidenceDate: Date | string | null;
  accepted?: boolean;
  customerName?: string | null;
}

export interface DimResult {
  score: DimScore;
  evidenceIds: string[];
  note: string;
  override?: boolean;
}

function monthsAgo(d: Date | string | null, now: Date): number | null {
  if (!d) return null;
  const date = typeof d === 'string' ? new Date(d) : d;
  return (now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24 * 30.4);
}

/** Kanıt kuralına göre boyut puanı: 0, 0.5, 1 veya bilinmiyor (null). */
export function scoreDimension(dim: QDimension, evidence: EvidenceLike[], now = new Date()): DimResult {
  const items = evidence.filter((e) => e.dimension === dim && e.accepted !== false);
  if (items.length === 0) return { score: null, evidenceIds: [], note: 'Kanıt yok (bilinmiyor)' };
  const ids = items.map((e) => e.id);
  const strong = items.filter((e) => e.confidence === 'high');
  switch (dim) {
    case 'customer': {
      // Global ağ müşterisi yerel ofisin müşterisi sayılmaz; logo duvarı zayıf kanıttır.
      const localDated = items.filter(
        (e) => e.scope === 'local' && e.claimType !== 'logo_wall' && e.confidence !== 'low',
      );
      const names = new Set(localDated.map((e) => (e.customerName ?? '').toLowerCase()).filter(Boolean));
      if (names.size >= 2 || (names.size >= 1 && localDated.some((e) => e.confidence === 'high')))
        return { score: 1, evidenceIds: ids, note: 'İsimli yerel marka işleri doğrulandı' };
      return { score: 0.5, evidenceIds: ids, note: 'Yalnızca logo duvarı / global veya zayıf müşteri kanıtı' };
    }
    case 'campaign': {
      const recent = items.filter((e) => {
        const m = monthsAgo(e.evidenceDate, now);
        return m !== null && m <= 24 && e.claimType !== 'logo_wall';
      });
      if (recent.length >= 2 || (recent.length >= 1 && strong.length >= 1))
        return { score: 1, evidenceIds: ids, note: 'Son 24 ayda tarihli vaka/üretim' };
      return { score: 0.5, evidenceIds: ids, note: 'Tarihsiz veya eski vaka' };
    }
    case 'reputation': {
      const award = items.filter((e) => ['award', 'independent'].includes(e.claimType) && e.confidence !== 'low');
      if (award.length >= 1 && award.some((e) => e.confidence === 'high'))
        return { score: 1, evidenceIds: ids, note: 'Resmî ödül / bağımsız kredi' };
      return { score: 0.5, evidenceIds: ids, note: 'Sınırlı bağımsız itibar kanıtı' };
    }
    case 'service_fit':
    case 'production': {
      if (strong.length >= 1 || items.length >= 2)
        return { score: 1, evidenceIds: ids, note: dim === 'service_fit' ? 'Hizmetler hedef role uygun' : 'Ekip/stüdyo doğrulandı' };
      return { score: 0.5, evidenceIds: ids, note: 'Kısmi kanıt' };
    }
  }
}

export interface QResult {
  q: number;
  coverage: number;
  dims: Record<QDimension, DimResult>;
}

export function computeQ(
  evidence: EvidenceLike[],
  overrides: Partial<Record<QDimension, { score: DimScore; note?: string }>> = {},
  weights: Partial<Record<QDimension, number>> = {},
  now = new Date(),
): QResult {
  const w = { ...DEFAULT_Q_WEIGHTS, ...weights };
  const total = Q_DIMENSIONS.reduce((s, d) => s + (w[d] ?? 0), 0) || 100;
  const dims = {} as Record<QDimension, DimResult>;
  let q = 0;
  let covered = 0;
  for (const d of Q_DIMENSIONS) {
    const auto = scoreDimension(d, evidence, now);
    const o = overrides[d];
    const r: DimResult =
      o && o.score !== undefined ? { score: o.score, evidenceIds: auto.evidenceIds, note: o.note ?? 'Kullanıcı değerlendirmesi', override: true } : auto;
    dims[d] = r;
    if (r.score !== null) {
      const weight = ((w[d] ?? 0) / total) * 100;
      q += weight * r.score;
      covered += weight;
    }
  }
  return { q: Math.round(q * 10) / 10, coverage: Math.round((covered / 100) * 100) / 100, dims };
}

// ───────────── Rol uyumu F ─────────────

export const F_WEIGHTS = { scope: 35, title: 20, conditions: 20, geo: 25 } as const;

export interface Condition {
  key: string;
  label: string;
  required: boolean;
  met: boolean | null;
}

export interface FInput {
  titleMatch: 'exact' | 'adjacent' | 'excluded' | 'none';
  /** Görev kapsamı: 1 tam, 0.5 kısmi, 0 uyumsuz, null bilinmiyor */
  scope: DimScore;
  conditions: Condition[];
  location: 'primary' | 'conditional' | 'remote' | 'outside' | 'unknown';
}

export interface FResult {
  f: number;
  coverage: number;
  mandatoryUnknown: boolean;
  mandatoryFailed: boolean;
  breakdown: Record<string, { score: DimScore; weight: number; note: string }>;
}

export function computeF(input: FInput): FResult {
  const titleScore: DimScore =
    input.titleMatch === 'exact' ? 1 : input.titleMatch === 'adjacent' ? 0.5 : input.titleMatch === 'excluded' ? 0 : 0;
  const required = input.conditions.filter((c) => c.required);
  const mandatoryFailed = required.some((c) => c.met === false);
  const mandatoryUnknown = required.some((c) => c.met === null || c.met === undefined);
  let condScore: DimScore;
  if (input.conditions.length === 0) condScore = null;
  else if (mandatoryFailed) condScore = 0;
  else if (mandatoryUnknown) condScore = null;
  else {
    const optional = input.conditions.filter((c) => !c.required);
    const unmetOptional = optional.filter((c) => c.met === false).length;
    condScore = unmetOptional === 0 ? 1 : 0.5;
  }
  const geoScore: DimScore =
    input.location === 'primary' || input.location === 'remote'
      ? 1
      : input.location === 'conditional'
        ? 0.5
        : input.location === 'outside'
          ? 0
          : null;
  const breakdown = {
    scope: { score: input.scope, weight: F_WEIGHTS.scope, note: 'Görev kapsamı' },
    title: { score: titleScore, weight: F_WEIGHTS.title, note: `Unvan: ${input.titleMatch}` },
    conditions: {
      score: condScore,
      weight: F_WEIGHTS.conditions,
      note: mandatoryFailed ? 'Zorunlu koşul karşılanmıyor' : mandatoryUnknown ? 'Zorunlu koşul bilinmiyor' : 'Aday koşulları',
    },
    geo: { score: geoScore, weight: F_WEIGHTS.geo, note: `Konum: ${input.location}` },
  };
  let f = 0;
  let covered = 0;
  for (const b of Object.values(breakdown)) {
    if (b.score !== null) {
      f += b.weight * b.score;
      covered += b.weight;
    }
  }
  return {
    f: Math.round(f * 10) / 10,
    coverage: Math.round(covered) / 100,
    mandatoryUnknown,
    mandatoryFailed,
    breakdown,
  };
}

/** Görev metninin hedef kapsamla ilişkisini anahtar kelimelerle kabaca tahmin eder (AI analizi yoksa). */
export function estimateScope(description: string | null | undefined, keywords: string[], titleMatch: string): DimScore {
  if (!description || description.trim().length < 40) return titleMatch === 'exact' ? 0.5 : null;
  const text = description.toLowerCase();
  const hits = keywords.filter((k) => k && text.includes(k.toLowerCase())).length;
  if (keywords.length === 0) return titleMatch === 'exact' ? 1 : 0.5;
  if (hits >= Math.min(3, keywords.length)) return 1;
  if (hits >= 1) return 0.5;
  return 0;
}

// ───────────── Kategori ─────────────

export type OpportunityCategory =
  | 'target_open'
  | 'adjacent_open'
  | 'past_closed'
  | 'not_found'
  | 'sector_target'
  | 'needs_confirmation'
  | 'excluded';

export const CATEGORY_LABELS: Record<OpportunityCategory, string> = {
  target_open: 'Hedef rol açık',
  adjacent_open: 'Yakın rol açık',
  past_closed: 'Geçmiş hedef rol kapalı',
  not_found: 'Bu taramada hedef ilan bulunamadı',
  sector_target: 'Sektörel hedef',
  needs_confirmation: 'Teyit gerekli',
  excluded: 'Hariç',
};

export function categorizeJobOpportunity(input: {
  titleMatch: 'exact' | 'adjacent' | 'excluded' | 'none';
  jobStatus: string;
  sourceHealthy: boolean;
  hasConflict: boolean;
}): OpportunityCategory | null {
  if (input.titleMatch === 'excluded') return 'excluded';
  if (input.titleMatch === 'none') return null;
  if (!input.sourceHealthy || input.hasConflict || input.jobStatus === 'unknown' || input.jobStatus === 'stale')
    return 'needs_confirmation';
  if (input.jobStatus === 'closed') return 'past_closed';
  if (input.jobStatus === 'open') return input.titleMatch === 'exact' ? 'target_open' : 'adjacent_open';
  return 'needs_confirmation';
}

export function categorizeCompanyOpportunity(input: {
  sectorExcluded: boolean;
  hadCompleteCrawl: boolean;
  anySourceBlocked: boolean;
}): OpportunityCategory {
  if (input.sectorExcluded) return 'excluded';
  if (input.anySourceBlocked) return 'needs_confirmation';
  if (input.hadCompleteCrawl) return 'not_found';
  return 'sector_target';
}
