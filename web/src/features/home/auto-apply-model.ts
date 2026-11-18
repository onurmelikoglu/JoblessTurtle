import type { AtsCvLayout, AtsMaxPages, AtsRewriteMode, AutoApplySettings, AutoWorkMode, EmployeeRange } from '@/api/types';

export const WORK_MODE_TEXT: Record<AutoWorkMode, string> = { onsite: 'Yerinde', hybrid: 'Hibrit', remote: 'Uzaktan' };
export const AUTO_WORK_MODES: AutoWorkMode[] = ['onsite', 'hybrid', 'remote'];

export const RANGE_TEXT: Record<EmployeeRange, string> = {
  '1-10': '1-10',
  '11-50': '11-50',
  '51-200': '51-200',
  '201-500': '201-500',
  '501-1000': '501-1.000',
  '1001-5000': '1.001-5.000',
  '5001+': '5.000+',
};

export const REWRITE_MODE_TEXT: Record<AtsRewriteMode, { label: string; hint: string }> = {
  fill_gaps: { label: 'Eksik becerileri de ekle', hint: 'İlanda istenip CV’nde olmayan beceriler de eklenir; bunlar CV listesinde "kanıtsız" diye işaretlenir.' },
  evidence_only: { label: 'Yalnız CV’de olanı öne çıkar', hint: 'CV’ndeki deneyim ilanın diliyle yeniden yazılır; olmayan beceri eklenmez.' },
};

export const CV_LAYOUT_TEXT: Record<AtsCvLayout, { label: string; hint: string }> = {
  original: { label: 'Orijinal tasarım (fotoğraflı)', hint: 'Fotoğraf, renkler, sütunlar ve bölüm başlıkları orijinal CV’ndeki gibi kalır; yalnız metin ilana göre değişir. Sonuç yine PDF.' },
  plain: { label: 'Sade ATS şablonu', hint: 'Tek sütun, fotoğrafsız, düz metin. ATS’nin en kolay okuduğu biçim.' },
};

export const MAX_PAGES_TEXT: Record<AtsMaxPages, { label: string; hint: string }> = {
  1: { label: '1 sayfa', hint: 'İyileştirilmiş CV tek sayfayı geçmez; sığmazsa önce ilanla ilgisiz beceriler, sonra eski deneyimlerdeki fazla maddeler kısaltılır.' },
  2: { label: '2 sayfa', hint: 'İyileştirilmiş CV en fazla iki sayfa olur; aşarsa aynı sırayla kısaltılır.' },
};

const DAILY_QUERY_TARGET = 4;

/** Sunucudaki queriesPerRun ile aynı: bir aramadaki sorgu sayısı. */
export function queriesPerRun(everyHours: number): number {
  return Math.max(1, Math.ceil((DAILY_QUERY_TARGET * everyHours) / 24));
}

/** Seçilen aralıkta günde yaklaşık kaç yapay zekâ ilan araması (her biri bir AI hakkı) yapılır. */
export function dailySearches(everyHours: number): number {
  return Math.round((24 / everyHours) * queriesPerRun(everyHours));
}

export function intervalLabel(hours: number): string {
  return hours === 24 ? 'Günde bir' : `${hours} saatte bir`;
}

export function toggled<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

export type AutoApplyForm = Omit<AutoApplySettings, 'autoSend'>;

export function formOf(settings: AutoApplySettings): AutoApplyForm {
  const { autoSend: _autoSend, ...form } = settings;
  return form;
}

/** Kaydetmeden önce kullanıcıya gösterilen sorunlar; boşsa kaydedilebilir. */
export function formProblems(form: AutoApplyForm): string[] {
  const problems: string[] = [];
  if (!Number.isInteger(form.dailyLimit) || form.dailyLimit < 1 || form.dailyLimit > 100) problems.push('Günlük başvuru sayısı 1 ile 100 arasında olmalı');
  if (form.filterWorkModes.length === AUTO_WORK_MODES.length) problems.push('Üç çalışma şeklini birden seçmek filtre koymamakla aynı; seçimi boş bırak');
  if (form.fMin < 0 || form.fMin > 100 || form.qMin < 0 || form.qMin > 100) problems.push('Eşikler 0 ile 100 arasında olmalı');
  if (form.atsThreshold < 40 || form.atsThreshold > 95) problems.push('ATS eşiği %40 ile %95 arasında olmalı');
  return problems;
}
