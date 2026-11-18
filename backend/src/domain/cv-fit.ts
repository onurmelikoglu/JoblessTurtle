import { cvHas, normalizeTerm, StructuredCv } from './ats';

/** İyileştirilmiş CV'nin en fazla kaç A4 sayfa olabileceği (kullanıcı ayarı). */
export const CV_MAX_PAGES_OPTIONS = [1, 2] as const;
export type CvMaxPages = (typeof CV_MAX_PAGES_OPTIONS)[number];
export const DEFAULT_CV_MAX_PAGES: CvMaxPages = 1;

/** Yeniden yazılan CV orijinalden en fazla bu oranda uzun olabilir; eksik terimler mevcut cümlelere yerleştirilir. */
export const REWRITE_GROWTH_LIMIT = 1.1;
export const REWRITE_MAX_BULLETS = 3;
export const REWRITE_MAX_SKILLS = 12;
export const REWRITE_MAX_SKILL_WORDS = 3;
/** Unvan tek satırda kalsın diye orijinal unvandan en fazla bu kadar karakter uzun olabilir. */
const TITLE_EXTRA_CHARS = 12;
const TITLE_MIN_CHARS = 40;
const TITLE_SEPARATORS = [' | ', ' (', ' / ', ' – ', ' - ', ', '];

export function cvWords(cv: StructuredCv): number {
  const parts = [
    cv.title,
    cv.summary,
    ...cv.skills,
    ...cv.languages,
    ...cv.certifications,
    ...cv.experience.flatMap((e) => [e.role, e.company, e.period, e.location, ...e.bullets]),
    ...cv.education.flatMap((e) => [e.school, e.degree, e.period]),
    ...cv.projects.flatMap((p) => [p.name, p.description]),
  ];
  return parts.reduce((sum, p) => sum + (p?.trim() ? p.trim().split(/\s+/).length : 0), 0);
}

/** Yeniden yazma için uzunluk bütçesi: orijinal sayfa sayısı sınırı aşıyorsa bütçe oranla küçülür. */
export function rewriteBudget(original: StructuredCv, originalPages: number, maxPages: number) {
  const pageRatio = originalPages > maxPages ? maxPages / originalPages : 1;
  return {
    maxPages,
    maxWords: Math.round(cvWords(original) * REWRITE_GROWTH_LIMIT * pageRatio),
    maxBullets: REWRITE_MAX_BULLETS,
    maxSkills: Math.max(REWRITE_MAX_SKILLS, original.skills.length),
    maxSkillWords: REWRITE_MAX_SKILL_WORDS,
    maxTitleChars: titleLimit(original),
    summarySentences: Math.max(2, sentencesOf(original.summary).length),
  };
}

function titleLimit(original: StructuredCv): number {
  return Math.max(TITLE_MIN_CHARS, (original.title?.trim().length ?? 0) + TITLE_EXTRA_CHARS);
}

/**
 * Yeniden yazılan unvan çok uzunsa ("A (B) | C" gibi) ilk ayraçtan kesilir; yine uzunsa orijinal unvan kalır. Uzun unvan
 * şablondaki tek satırlık alana sığmayıp yanındaki iletişim sütununa taşar.
 */
export function clampTitle(original: StructuredCv, rewritten: StructuredCv): StructuredCv {
  const title = rewritten.title?.trim();
  const limit = titleLimit(original);
  if (!title || title.length <= limit) return rewritten;
  const cut = TITLE_SEPARATORS.map((sep) => title.indexOf(sep)).filter((i) => i > 0);
  const head = cut.length ? title.slice(0, Math.min(...cut)).trim() : '';
  return { ...rewritten, title: head && head.length <= limit ? head : (original.title ?? null) };
}

interface ShrinkLevel {
  skills: number;
  /** Deneyim başına madde sınırı: ilki en yeni deneyim için, ikincisi diğerleri için. */
  bullets: [number, number];
  summarySentences: number | null;
  projects: number | null;
  projectSentences: number | null;
  certifications: number | null;
}

/**
 * Sayfaya sığmayan CV adım adım kısaltılır; her adım bir öncekinden daha kısadır. Özet ("Hakkımda") en son ve en fazla
 * iki cümleye kadar kısalır; tek satıra inen özet CV'nin duruşunu bozar.
 */
const SHRINK_LEVELS: ShrinkLevel[] = [
  { skills: 12, bullets: [3, 3], summarySentences: null, projects: null, projectSentences: null, certifications: null },
  { skills: 10, bullets: [3, 2], summarySentences: null, projects: null, projectSentences: 1, certifications: 5 },
  { skills: 8, bullets: [2, 2], summarySentences: null, projects: 3, projectSentences: 1, certifications: 3 },
  { skills: 8, bullets: [2, 1], summarySentences: 3, projects: 2, projectSentences: 1, certifications: 2 },
  { skills: 6, bullets: [2, 1], summarySentences: 2, projects: 2, projectSentences: 1, certifications: 2 },
];

export const SHRINK_LEVEL_COUNT = SHRINK_LEVELS.length;

const SENTENCE = /[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g;

function sentencesOf(text: string | null | undefined): string[] {
  return text?.match(SENTENCE)?.map((s) => s.trim()).filter(Boolean) ?? [];
}

function firstSentences(text: string | null | undefined, count: number | null): string | null | undefined {
  if (!text || count === null) return text;
  const sentences = sentencesOf(text);
  return sentences.length > count ? sentences.slice(0, count).join(' ') : text;
}

const wordCount = (s: string) => s.trim().split(/\s+/).length;

/**
 * Sınır aşılırsa önce ilanla eşleşmeyen, aralarında da en uzun adlı beceriler düşer (dar sütunda birkaç satıra sarılıp en
 * çok yeri onlar kaplar). Kalanlar CV'deki sıralarını korur.
 */
function prioritizedSkills(skills: string[], keepTerms: string[], limit: number): string[] {
  const wanted = keepTerms.map(normalizeTerm).filter(Boolean);
  const matches = (skill: string) => {
    const hay = ` ${normalizeTerm(skill)} `;
    return wanted.some((t) => cvHas(hay, t) || normalizeTerm(skill) === t);
  };
  const ranked = skills.map((skill, index) => ({ skill, index, miss: matches(skill) ? 0 : 1, words: wordCount(skill) })).sort((a, b) => a.miss - b.miss || a.words - b.words || a.index - b.index);
  const kept = new Set(ranked.slice(0, limit).map((r) => r.skill));
  return skills.filter((s) => kept.has(s));
}

/**
 * CV'yi verilen kısaltma düzeyine indirir (0 = ilk düzey). Ad, iletişim, işverenler, dönemler ve eğitim değişmez; yalnız
 * beceri listesi, eski deneyimlerin maddeleri, özet, projeler ve sertifikalar kısalır. Düzey yoksa null döner.
 */
export function shrinkCv(cv: StructuredCv, keepTerms: string[], level: number): StructuredCv | null {
  const rule = SHRINK_LEVELS[level];
  if (!rule) return null;
  const [latest, older] = rule.bullets;
  return {
    ...cv,
    summary: firstSentences(cv.summary, rule.summarySentences),
    skills: prioritizedSkills(cv.skills, keepTerms, rule.skills),
    experience: cv.experience.map((e, i) => ({ ...e, bullets: e.bullets.slice(0, i === 0 ? latest : older) })),
    projects: (rule.projects === null ? cv.projects : cv.projects.slice(0, rule.projects)).map((p) => ({ ...p, description: firstSentences(p.description, rule.projectSentences) ?? null })),
    certifications: rule.certifications === null ? cv.certifications : cv.certifications.slice(0, rule.certifications),
  };
}
