/**
 * Kendi verimizle eğitilen hafif modeller: kategorik özelliklerden ikili bir sonucun (ulaştı mı, yanıt geldi mi)
 * olasılığını kestiren, L2 düzenlileştirmeli lojistik regresyon. Düzenlileştirme az örnekte ağırlıkları sıfıra çeker
 * (kestirim temel orana yaklaşır), örnek biriktikçe veri baskın gelir; böylece "az veride düzleştirilmiş oran, çok
 * veride regresyon" tek kuralla elde edilir. Model ancak çapraz doğrulamada temel orandan iyi çıkarsa etkinleşir.
 */
export interface Sample {
  /** Örneği katlara dağıtmak için kararlı kimlik. */
  key: string;
  features: Record<string, string>;
  label: 0 | 1;
}

export interface LogisticModel {
  intercept: number;
  /** "özellik=değer" → log-odds katkısı; eğitimde yeterince görülmemiş değerlerin katkısı yoktur. */
  weights: Record<string, number>;
}

export interface ModelMetrics {
  samples: number;
  positives: number;
  baseRate: number;
  /** Çapraz doğrulamada (kat dışı tahminlerle) ortalama log-kayıp; düşük olan iyidir. */
  logLoss: number;
  /** Herkese temel oranı tahmin eden modelin log-kaybı. */
  baselineLogLoss: number;
  /** Temel orana göre iyileşme: 1 − logLoss / baselineLogLoss. Sıfır ve altı, modelin bir şey öğrenmediğini gösterir. */
  gain: number;
  /** Rastgele bir olumlu örneğin olumsuzdan yüksek puan alma olasılığı; 0,5 rastgele demektir. */
  auc: number | null;
}

export interface FeatureEffect {
  feature: string;
  value: string;
  samples: number;
  /** Bu değeri taşıyan örneklerde gözlenen olumlu oranı. */
  rate: number;
  weight: number;
}

export type InactiveReason = 'few_samples' | 'few_of_one_outcome' | 'no_gain';

export interface TrainedModel extends LogisticModel {
  name: string;
  trainedAt: string;
  features: string[];
  metrics: ModelMetrics;
  active: boolean;
  inactiveReason: InactiveReason | null;
  effects: FeatureEffect[];
}

export interface TrainingOptions {
  l2: number;
  iterations: number;
  /** Bir değerin kendi ağırlığını alması için gereken en az örnek; daha nadir değerler temel oranda kalır. */
  minValueSamples: number;
  folds: number;
  minSamples: number;
  /** Az görülen sonuçtan (olumlu ya da olumsuz) gereken en az örnek. */
  minMinority: number;
  minGain: number;
}

export const DEFAULT_TRAINING: TrainingOptions = { l2: 5, iterations: 25, minValueSamples: 8, folds: 5, minSamples: 120, minMinority: 20, minGain: 0.01 };

const EPSILON = 1e-9;
const MAX_EFFECTS = 24;
/** Newton adımı hedefi kötüleştirirse yarıya indirilir; bu sınırın altında aramaktan vazgeçilir. */
const MIN_STEP = 1 / 1024;
const CONVERGED_BELOW = 1e-9;

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
const logit = (p: number) => Math.log(p / (1 - p));
const clamp = (p: number) => Math.min(1 - EPSILON, Math.max(EPSILON, p));
const termOf = (feature: string, value: string) => `${feature}=${value}`;
const logLossOf = (p: number, label: 0 | 1) => -Math.log(clamp(label === 1 ? p : 1 - p));

function termsOf(features: Record<string, string>, vocabulary: ReadonlySet<string>): string[] {
  return Object.entries(features)
    .map(([feature, value]) => termOf(feature, value))
    .filter((term) => vocabulary.has(term));
}

function vocabularyOf(samples: Sample[], minValueSamples: number): Set<string> {
  const counts = new Map<string, number>();
  for (const s of samples) for (const [feature, value] of Object.entries(s.features)) counts.set(termOf(feature, value), (counts.get(termOf(feature, value)) ?? 0) + 1);
  return new Set([...counts].filter(([, n]) => n >= minValueSamples && n < samples.length).map(([term]) => term));
}

/** Toplama sırası sonucu son basamakta değiştirir; örnekler kimliğe göre sıralanarak sonuç veri sırasından bağımsız kılınır. */
function ordered(samples: Sample[]): Sample[] {
  return [...samples].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** d×d doğrusal sistemi kısmi pivotlu Gauss eleme ile çözer; özellik sayısı onlarla sınırlı olduğu için yeterlidir. */
function solve(matrix: number[][], vector: number[]): number[] {
  const n = vector.length;
  const a = matrix.map((row, i) => [...row, vector[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const divisor = a[col][col] || EPSILON;
    for (let row = col + 1; row < n; row++) {
      const factor = a[row][col] / divisor;
      if (!factor) continue;
      for (let k = col; k <= n; k++) a[row][k] -= factor * a[col][k];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let row = n - 1; row >= 0; row--) {
    let sum = a[row][n];
    for (let k = row + 1; k < n; k++) sum -= a[row][k] * x[k];
    x[row] = sum / (a[row][row] || EPSILON);
  }
  return x;
}

/**
 * Newton yöntemiyle eğitim; her adım hedef fonksiyonunu (log-kayıp + L2 cezası) düşürmüyorsa küçültülür, böylece
 * birbirini tekrarlayan özelliklerde ve neredeyse ayrışan veride de yakınsar. Aynı veriyle her zaman aynı model çıkar.
 * Sabit terim düzenlileştirilmez; özellik bilgisi olmayan örnek temel orana yakın bir kestirim alır.
 */
export function trainLogistic(unordered: Sample[], opts: Pick<TrainingOptions, 'l2' | 'iterations' | 'minValueSamples'> = DEFAULT_TRAINING): LogisticModel {
  const samples = ordered(unordered);
  const positives = samples.filter((s) => s.label === 1).length;
  if (!samples.length || positives === 0 || positives === samples.length) return { intercept: samples.length ? logit(clamp(positives / samples.length)) : 0, weights: {} };
  const terms = [...vocabularyOf(samples, opts.minValueSamples)].sort();
  const indexOf = new Map(terms.map((term, i) => [term, i + 1]));
  const rows = samples.map((s) => ({ active: [0, ...termsOf(s.features, new Set(terms)).map((term) => indexOf.get(term)!)], label: s.label }));
  const size = terms.length + 1;
  let w = new Array<number>(size).fill(0);
  w[0] = logit(clamp(positives / samples.length));
  const objective = (weights: number[]) => {
    let loss = 0;
    for (const row of rows) loss += logLossOf(sigmoid(row.active.reduce((sum, j) => sum + weights[j], 0)), row.label);
    for (let j = 1; j < size; j++) loss += (opts.l2 / 2) * weights[j] * weights[j];
    return loss;
  };
  let current = objective(w);
  for (let i = 0; i < opts.iterations; i++) {
    const gradient = new Array<number>(size).fill(0);
    const hessian = Array.from({ length: size }, () => new Array<number>(size).fill(0));
    for (const row of rows) {
      const p = sigmoid(row.active.reduce((sum, j) => sum + w[j], 0));
      const curvature = Math.max(p * (1 - p), EPSILON);
      for (const j of row.active) {
        gradient[j] += p - row.label;
        for (const k of row.active) hessian[j][k] += curvature;
      }
    }
    for (let j = 1; j < size; j++) {
      gradient[j] += opts.l2 * w[j];
      hessian[j][j] += opts.l2;
    }
    const direction = solve(hessian, gradient);
    let step = 1;
    let next = w.map((value, j) => value - direction[j]);
    let nextObjective = objective(next);
    while (!(nextObjective <= current) && step > MIN_STEP) {
      step /= 2;
      next = w.map((value, j) => value - step * direction[j]);
      nextObjective = objective(next);
    }
    if (!(nextObjective <= current)) break;
    const improvement = current - nextObjective;
    w = next;
    current = nextObjective;
    if (improvement < CONVERGED_BELOW) break;
  }
  return { intercept: w[0], weights: Object.fromEntries(terms.map((term, i) => [term, w[i + 1]])) };
}

export function predict(model: LogisticModel, features: Record<string, string>): number {
  let z = model.intercept;
  for (const [feature, value] of Object.entries(features)) z += model.weights[termOf(feature, value)] ?? 0;
  return sigmoid(z);
}

function hashOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function areaUnderCurve(scored: { score: number; label: 0 | 1 }[]): number | null {
  const positives = scored.filter((s) => s.label === 1).length;
  const negatives = scored.length - positives;
  if (!positives || !negatives) return null;
  const sorted = [...scored].sort((a, b) => a.score - b.score);
  let rankSum = 0;
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j < sorted.length && sorted[j].score === sorted[i].score) j++;
    const averageRank = (i + 1 + j) / 2;
    for (let k = i; k < j; k++) if (sorted[k].label === 1) rankSum += averageRank;
    i = j;
  }
  return (rankSum - (positives * (positives + 1)) / 2) / (positives * negatives);
}

/** Her örnek, kendisini görmemiş bir modelle puanlanır; ölçütler bu kat dışı tahminlerden hesaplanır. */
export function crossValidate(unordered: Sample[], opts: TrainingOptions = DEFAULT_TRAINING): ModelMetrics {
  const samples = ordered(unordered);
  const positives = samples.filter((s) => s.label === 1).length;
  const baseRate = samples.length ? positives / samples.length : 0;
  const empty = { samples: samples.length, positives, baseRate, logLoss: 0, baselineLogLoss: 0, gain: 0, auc: null };
  if (samples.length < opts.folds * 2 || positives === 0 || positives === samples.length) return empty;
  const foldOf = (s: Sample) => hashOf(s.key) % opts.folds;
  const scored: { score: number; label: 0 | 1 }[] = [];
  let loss = 0;
  let baselineLoss = 0;
  for (let fold = 0; fold < opts.folds; fold++) {
    const training = samples.filter((s) => foldOf(s) !== fold);
    const held = samples.filter((s) => foldOf(s) === fold);
    if (!held.length || !training.length) continue;
    const model = trainLogistic(training, opts);
    const trainingRate = clamp(training.filter((s) => s.label === 1).length / training.length);
    for (const s of held) {
      const score = predict(model, s.features);
      scored.push({ score, label: s.label });
      loss += logLossOf(score, s.label);
      baselineLoss += logLossOf(trainingRate, s.label);
    }
  }
  if (!scored.length) return empty;
  const logLoss = loss / scored.length;
  const baselineLogLoss = baselineLoss / scored.length;
  return { samples: samples.length, positives, baseRate, logLoss, baselineLogLoss, gain: baselineLogLoss > 0 ? 1 - logLoss / baselineLogLoss : 0, auc: areaUnderCurve(scored) };
}

function effectsOf(samples: Sample[], model: LogisticModel): FeatureEffect[] {
  const stats = new Map<string, { feature: string; value: string; samples: number; positives: number }>();
  for (const s of samples) {
    for (const [feature, value] of Object.entries(s.features)) {
      const term = termOf(feature, value);
      const entry = stats.get(term) ?? { feature, value, samples: 0, positives: 0 };
      entry.samples++;
      entry.positives += s.label;
      stats.set(term, entry);
    }
  }
  return [...stats.entries()]
    .filter(([term]) => term in model.weights)
    .map(([term, e]) => ({ feature: e.feature, value: e.value, samples: e.samples, rate: e.positives / e.samples, weight: model.weights[term] }))
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
    .slice(0, MAX_EFFECTS);
}

function inactiveReasonOf(metrics: ModelMetrics, opts: TrainingOptions): InactiveReason | null {
  if (metrics.samples < opts.minSamples) return 'few_samples';
  if (Math.min(metrics.positives, metrics.samples - metrics.positives) < opts.minMinority) return 'few_of_one_outcome';
  if (metrics.gain < opts.minGain) return 'no_gain';
  return null;
}

/** Modeli tüm veriyle eğitir, çapraz doğrulamayla ölçer ve kullanılmaya değer olup olmadığına karar verir. */
export function fitModel(name: string, samples: Sample[], opts: TrainingOptions = DEFAULT_TRAINING, now = new Date()): TrainedModel {
  const metrics = crossValidate(samples, opts);
  const model = trainLogistic(samples, opts);
  const inactiveReason = inactiveReasonOf(metrics, opts);
  return {
    ...model,
    name,
    trainedAt: now.toISOString(),
    features: [...new Set(samples.flatMap((s) => Object.keys(s.features)))].sort(),
    metrics,
    active: inactiveReason === null,
    inactiveReason,
    effects: effectsOf(samples, model),
  };
}
