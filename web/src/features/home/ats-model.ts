import type { HomeAtsItem, HomeAtsOverview } from '@/api/types';
import type { Tone } from '@/ui/tones';

/** Eşiğin altı kırmızı, eşiğe 10 puandan yakın sarı, üstü yeşil. */
const NEAR_THRESHOLD = 10;

export function atsTone(score: number, threshold: number): Tone {
  if (score >= threshold) return 'good';
  return score >= threshold - NEAR_THRESHOLD ? 'warn' : 'bad';
}

const VARIANT_LABEL: Record<string, string> = { original: 'Orijinal CV', ats_main: 'ATS CV', ats_job: 'Bu ilana özel ATS CV' };
export const variantLabel = (variant: string) => VARIANT_LABEL[variant] ?? 'CV';

export function scoreOf(ats: HomeAtsOverview | null | undefined, documentId: string): number | null {
  return ats?.status === 'ready' ? (ats.items.find((i) => i.documentId === documentId)?.score ?? null) : null;
}

/** Ekli CV eşiğin altındaysa ya da hiç CV ekli değilse iyileştirme önerilir. */
export function needsImprovement(ats: HomeAtsOverview | null | undefined): boolean {
  if (ats?.status !== 'ready') return false;
  return ats.attachedScore === null ? (ats.best?.score ?? 0) < ats.threshold : ats.attachedScore < ats.threshold;
}

/** Ekli CV bir ATS sürümüyse "İyileştir" onu yeniden yazar (eskisinin yerine yenisi geçer). */
export function attachedIsAts(ats: HomeAtsOverview | null | undefined): boolean {
  return ats?.status === 'ready' && ats.items.some((i) => i.attached && i.variant !== 'original');
}

/** Ekli olandan daha yüksek oranlı hazır sürüm (ekle önerisi); yoksa null. */
export function betterVersion(ats: HomeAtsOverview | null | undefined): HomeAtsItem | null {
  if (ats?.status !== 'ready') return null;
  const attached = ats.attachedScore ?? -1;
  const best = ats.items.reduce<HomeAtsItem | null>((top, i) => (!top || i.score > top.score ? i : top), null);
  return best && !best.attached && best.score > attached ? best : null;
}

export const ATS_STATUS_TEXT: Record<Exclude<HomeAtsOverview['status'], 'ready'>, string | null> = {
  preparing: 'CV ilana göre puanlanıyor…',
  no_job: null,
  no_cv: 'Bu dilde yüklenmiş CV yok; ATS oranı hesaplanamıyor.',
  no_description: 'İlanın metni ilan sayfasından da okunamadığı için ATS oranı hesaplanamıyor.',
  unavailable: 'ATS oranı şu an hesaplanamadı (yapay zekâ kullanılamıyor); biraz sonra yeniden dene.',
};

/** "%54 → %82" gibi. */
export function improvementText(before: number | null, after: number | null): string {
  if (after === null) return 'CV iyileştirildi';
  return before === null ? `ATS uyumu %${after}` : `ATS uyumu %${before} → %${after}`;
}
