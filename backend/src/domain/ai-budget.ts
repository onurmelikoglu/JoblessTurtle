/**
 * Yapay zekâ görevlerinin öncelik sınıfları. Günlük görev hakkı ve aboneliğin kullanım penceresi daraldıkça önce
 * düşük öncelikli sınıflar durur; kalan pay kullanıcının beklediği işlere ve mail dönüşü düzeltmelerine kalır.
 * Öncelik sırası: etkileşimli > düzeltme > yazı > araştırma > keşif.
 */
export const AI_CLASSES = ['interactive', 'fix', 'letters', 'research', 'discovery'] as const;
export type AiClass = (typeof AI_CLASSES)[number];

export const AI_CLASS_LABELS: Record<AiClass, string> = {
  interactive: 'Senin başlattığın işlemler',
  fix: 'Gelen kutusu: mail dönüşleri ve iş alarmları',
  letters: 'Yazı hazırlama',
  research: 'Firma ve adres araştırması',
  discovery: 'Firma ve ilan keşfi',
};

const KIND_CLASS: Record<string, AiClass> = {
  company_lookup: 'interactive',
  inbound_review: 'fix',
  inbound_fix: 'fix',
  reply_classification: 'fix',
  job_alert: 'fix',
  letter_template: 'letters',
  letter_company_line: 'letters',
  mail_draft: 'letters',
  mail_translate: 'letters',
  cv_facts: 'letters',
  follow_up: 'letters',
  company_report: 'research',
  company_contacts: 'research',
  company_sizes: 'research',
  title_analysis: 'research',
  company_discovery: 'discovery',
  job_search: 'discovery',
  title_expansion: 'discovery',
};

export function aiClassOf(kind: string): AiClass {
  return KIND_CLASS[kind] ?? 'research';
}

/** Günün toplam görev sayısı günlük hakkın bu oranına ulaşınca sınıf durur. */
export const DAILY_CEILING: Record<AiClass, number> = { interactive: 1, fix: 0.95, letters: 0.75, research: 0.65, discovery: 0.5 };

/** Sınıfın tek başına kullanabileceği en büyük günlük pay. */
export const DAILY_SHARE: Record<AiClass, number> = { interactive: 1, fix: 0.3, letters: 0.5, research: 0.4, discovery: 0.2 };

/** Aboneliğin kullanım penceresi (5 saatlik, haftalık) bu orana ulaşınca sınıf o sağlayıcıyı kullanmaz. */
export const UTILIZATION_CEILING: Record<AiClass, number> = { interactive: 0.9, fix: 0.88, letters: 0.8, research: 0.7, discovery: 0.6 };

export const classUsageKey = (cls: AiClass) => `ai:class:${cls}`;

/** Sınıf en az bir görev çalıştırabilsin diye küçük günlük haklarda tavan 1'in altına inmez. */
export function dailyCeiling(cls: AiClass, dailyLimit: number): number {
  return dailyLimit <= 0 ? 0 : Math.max(1, Math.floor(dailyLimit * DAILY_CEILING[cls]));
}

export function dailyShare(cls: AiClass, dailyLimit: number): number {
  return dailyLimit <= 0 ? 0 : Math.max(1, Math.ceil(dailyLimit * DAILY_SHARE[cls]));
}

export type BudgetBlock = 'daily' | 'share' | null;

export function budgetBlock(cls: AiClass, usage: { dailyLimit: number; usedTotal: number; usedByClass: number }): BudgetBlock {
  if (usage.usedTotal >= dailyCeiling(cls, usage.dailyLimit)) return 'daily';
  if (usage.usedByClass >= dailyShare(cls, usage.dailyLimit)) return 'share';
  return null;
}

export interface UtilizationWindow {
  name: string;
  utilization: number;
  resetsAt: string | Date;
}

/** Süresi dolmamış pencerelerden en dolu olanı sınıfın tavanının altındaysa sağlayıcı kullanılabilir. */
export function utilizationAllows(cls: AiClass, windows: UtilizationWindow[] | null | undefined, now = Date.now()): boolean {
  const active = (windows ?? []).filter((w) => new Date(w.resetsAt).getTime() > now);
  return active.every((w) => w.utilization < UTILIZATION_CEILING[cls]);
}

/** Sınıfın yeniden açılacağı an: tavanı aşan pencerelerin en geç sıfırlananı. */
export function utilizationOpensAt(cls: AiClass, windows: UtilizationWindow[] | null | undefined, now = Date.now()): Date | null {
  const hot = (windows ?? []).filter((w) => new Date(w.resetsAt).getTime() > now && w.utilization >= UTILIZATION_CEILING[cls]);
  return hot.length ? new Date(Math.max(...hot.map((w) => new Date(w.resetsAt).getTime()))) : null;
}
