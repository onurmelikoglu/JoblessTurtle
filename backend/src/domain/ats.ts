/**
 * ATS uyumu: CV'nin ilan gereksinimlerini karşılama oranı ve iyileştirme ayarları. Yapay zekâ CV'yi ve ilanı bir kez
 * yapısal hâle getirir; oran burada, yapay zekâsız ve tekrarlanabilir biçimde hesaplanır (toplu listede onlarca ilan).
 */
import { fold } from './text';

export const DEFAULT_ATS_THRESHOLD = 70;
export const MIN_ATS_THRESHOLD = 40;
export const MAX_ATS_THRESHOLD = 95;
export const ATS_REWRITE_MODES = ['fill_gaps', 'evidence_only'] as const;
export type AtsRewriteModeValue = (typeof ATS_REWRITE_MODES)[number];
export const DEFAULT_ATS_REWRITE_MODE: AtsRewriteModeValue = 'fill_gaps';

export interface CvExperience {
  company: string;
  role: string;
  location?: string | null;
  period: string;
  bullets: string[];
}

export interface CvEducation {
  school: string;
  degree?: string | null;
  period?: string | null;
}

export interface StructuredCv {
  name: string;
  title?: string | null;
  contact: { email?: string | null; phone?: string | null; location?: string | null; links: string[] };
  summary?: string | null;
  experience: CvExperience[];
  education: CvEducation[];
  skills: string[];
  languages: string[];
  certifications: string[];
  projects: { name: string; description?: string | null }[];
}

export interface AtsProfile {
  hardSkills: string[];
  tools: string[];
  softSkills: string[];
  certifications: string[];
  languages: string[];
  minYears: number | null;
  education: string | null;
  titleKeywords: string[];
}

export type AtsDimension = 'skills' | 'title' | 'experience' | 'soft' | 'education' | 'languages';

export const ATS_WEIGHTS: Record<AtsDimension, number> = { skills: 45, title: 15, experience: 15, soft: 10, education: 10, languages: 5 };

export interface AtsResult {
  score: number;
  breakdown: Record<AtsDimension, { ratio: number; weight: number } | null>;
  missing: string[];
}

const MAX_MISSING = 20;

/** Aynı teknolojinin yaygın yazımları tek terime iner. */
const SYNONYMS: Record<string, string> = {
  js: 'javascript',
  ts: 'typescript',
  k8s: 'kubernetes',
  reactjs: 'react',
  'react js': 'react',
  'react.js': 'react',
  nodejs: 'node',
  'node.js': 'node',
  'node js': 'node',
  'vue.js': 'vue',
  vuejs: 'vue',
  'next.js': 'nextjs',
  postgres: 'postgresql',
  golang: 'go',
  'ci/cd': 'cicd',
  'ci cd': 'cicd',
  'c sharp': 'c#',
  dotnet: '.net',
  'asp.net core': 'asp.net',
  'ms sql': 'mssql',
  'sql server': 'mssql',
  'google cloud': 'gcp',
  'amazon web services': 'aws',
  'rest api': 'rest',
  restful: 'rest',
  ingilizce: 'english',
  turkce: 'turkish',
  almanca: 'german',
};

/** Terimin karşılaştırılabilir biçimi: Türkçe harfler katlanır, + # . / dışındaki işaretler boşluk olur. */
export function normalizeTerm(term: string): string {
  const folded = fold(term)
    .replace(/[^a-z0-9+#./ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return SYNONYMS[folded] ?? folded;
}

/** CV'nin aranabilir metni: her sözcük ve eş anlamlı karşılıkları, boşlukla çevrili. */
export function cvHaystack(cv: StructuredCv): string {
  const parts = [
    cv.title,
    cv.summary,
    ...cv.skills,
    ...cv.languages,
    ...cv.certifications,
    ...cv.experience.flatMap((e) => [e.role, e.company, ...e.bullets]),
    ...cv.education.flatMap((e) => [e.school, e.degree]),
    ...cv.projects.flatMap((p) => [p.name, p.description]),
  ];
  const text = ` ${parts
    .filter((p): p is string => !!p)
    .map((p) => fold(p).replace(/[^a-z0-9+#./ ]+/g, ' '))
    .join(' ')
    .replace(/\s+/g, ' ')} `;
  const aliases = Object.entries(SYNONYMS)
    .filter(([from]) => text.includes(` ${from} `))
    .map(([, to]) => to);
  return `${text}${aliases.join(' ')} `;
}

export function cvHas(haystack: string, term: string): boolean {
  const t = normalizeTerm(term);
  if (!t) return false;
  if (haystack.includes(` ${t} `)) return true;
  const stripped = t.replace(/[./]/g, ' ').replace(/\s+/g, ' ').trim();
  return stripped !== t && haystack.includes(` ${stripped} `);
}

const unique = (terms: string[]) => [...new Map(terms.filter((t) => normalizeTerm(t)).map((t) => [normalizeTerm(t), t.trim()])).values()];

function coverage(haystack: string, terms: string[]): { ratio: number; missing: string[] } | null {
  const list = unique(terms);
  if (!list.length) return null;
  const missing = list.filter((t) => !cvHas(haystack, t));
  return { ratio: (list.length - missing.length) / list.length, missing };
}

/**
 * CV'nin ilana uyum oranı (0-100). İlanda bulunmayan boyutlar hesaba girmez, kalan ağırlıklar oransal büyür. Deneyim
 * yılı adayın profilindeki yıldan, diğerleri CV metninde terimin geçmesinden hesaplanır.
 */
export function atsScore(cv: StructuredCv, profile: AtsProfile, experienceYears: number | null): AtsResult {
  const haystack = cvHaystack(cv);
  const skills = coverage(haystack, [...profile.hardSkills, ...profile.tools]);
  const title = coverage(haystack, profile.titleKeywords);
  const soft = coverage(haystack, profile.softSkills);
  const education = coverage(haystack, [...(profile.education ? [profile.education] : []), ...profile.certifications]);
  const languages = coverage(haystack, profile.languages);
  const experience = profile.minYears && profile.minYears > 0 ? { ratio: experienceYears === null ? 0.5 : Math.min(1, experienceYears / profile.minYears), missing: [] as string[] } : null;
  const parts: Record<AtsDimension, { ratio: number; missing: string[] } | null> = { skills, title, experience, soft, education, languages };
  let weighted = 0;
  let total = 0;
  const breakdown = {} as AtsResult['breakdown'];
  for (const dim of Object.keys(ATS_WEIGHTS) as AtsDimension[]) {
    const part = parts[dim];
    breakdown[dim] = part ? { ratio: Math.round(part.ratio * 100) / 100, weight: ATS_WEIGHTS[dim] } : null;
    if (!part) continue;
    weighted += part.ratio * ATS_WEIGHTS[dim];
    total += ATS_WEIGHTS[dim];
  }
  const missing = [...(skills?.missing ?? []), ...(title?.missing ?? []), ...(education?.missing ?? []), ...(languages?.missing ?? []), ...(soft?.missing ?? [])].slice(0, MAX_MISSING);
  return { score: total ? Math.round((weighted / total) * 100) : 0, breakdown, missing };
}

/**
 * Yeniden yazılan CV'de kimlik ve geçmiş değişmez: ad, iletişim, işveren adları, dönemler ve okullar orijinalden gelir.
 * Yapay zekâ deneyim sayısını değiştirdiyse orijinal sıra korunur, yalnızca aynı sıradaki maddeler alınır.
 */
export function lockIdentity(original: StructuredCv, rewritten: StructuredCv): StructuredCv {
  const experience = original.experience.map((orig, i) => {
    const next = rewritten.experience.find((e) => fold(e.company) === fold(orig.company) && fold(e.period) === fold(orig.period)) ?? rewritten.experience[i];
    return { ...orig, role: next?.role?.trim() || orig.role, bullets: next?.bullets?.length ? next.bullets : orig.bullets };
  });
  return {
    ...rewritten,
    name: original.name,
    contact: original.contact,
    experience,
    education: original.education,
    certifications: unique([...original.certifications, ...rewritten.certifications]),
    languages: unique([...original.languages, ...rewritten.languages]),
    skills: unique(rewritten.skills.length ? rewritten.skills : original.skills),
    projects: rewritten.projects.length ? rewritten.projects : original.projects,
  };
}

/** Orijinalde geçmeyen, iyileştirmeyle CV'ye giren beceriler. */
export function addedSkillsOf(original: StructuredCv, rewritten: StructuredCv): string[] {
  const haystack = cvHaystack(original);
  return unique(rewritten.skills).filter((s) => !cvHas(haystack, s));
}
