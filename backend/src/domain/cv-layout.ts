/**
 * CV görünüm şablonu: kullanıcının yüklediği CV'nin tasarımı (sütunlar, renkler, fotoğraf, bölüm başlıkları) yapay
 * zekâyla bir kez HTML/CSS şablonuna aktarılır. İyileştirilen her CV bu şablona yapay zekâsız doldurulur ve PDF'e
 * çevrilir; böylece ATS sürümü orijinal CV gibi görünür, metni ise yapısal içerikten birebir gelir.
 */
import Mustache from 'mustache';
import type { StructuredCv } from './ats';

export const CV_LAYOUT_MODES = ['original', 'plain'] as const;
export type CvLayoutMode = (typeof CV_LAYOUT_MODES)[number];
export const DEFAULT_CV_LAYOUT_MODE: CvLayoutMode = 'original';

/** Şablonda kullanılabilen gömülü yazı tipleri (açık lisanslı; Türkçe harfleri içerir). */
export const CV_FONTS: Record<string, string> = {
  Inter: 'inter',
  Montserrat: 'montserrat',
  Poppins: 'poppins',
  'Space Grotesk': 'space-grotesk',
  Archivo: 'archivo',
  Roboto: 'roboto',
  'Open Sans': 'open-sans',
  Lato: 'lato',
  'Playfair Display': 'playfair-display',
  Lora: 'lora',
  Raleway: 'raleway',
  Arimo: 'arimo',
};

export const CV_PHOTO_FILE = 'cv-photo.png';
export const MAX_LAYOUT_HTML = 80_000;

export interface CvLayout {
  html: string;
  /** Şablonda orijinalden çıkarılan fotoğraf kullanılıyor mu; fotoğraf dosyası `photoKey` ile saklanır. */
  usesPhoto: boolean;
  photoKey: string | null;
  /** Orijinal CV'nin sayfa sayısı; iyileştirilen CV bu sayıya sığdırılmaya çalışılır. */
  pages: number;
  /** Orijinal içeriğin bu şablonda kendi sayfa sayısına sığdığı ölçek; iyileştirilmiş CV en az buna kadar küçültülebilir. */
  fitScale?: number;
  createdAt: string;
}

/** Şablonun alanları: yapay zekâya anlatılır ve doldururken aynı adlarla verilir. */
export const LAYOUT_FIELDS = `{{name}}, {{title}}, {{email}}, {{phone}}, {{location}}, {{#links}}{{.}}{{/links}}
{{summary}}
{{#experience}} {{role}} {{company}} {{period}} {{location}} {{description}} {{#bullets}}{{.}}{{/bullets}} {{/experience}}
{{#education}} {{school}} {{degree}} {{period}} {{/education}}
{{#skills}}{{.}}{{/skills}} ya da tek metin olarak {{skillsText}}
{{#languages}}{{.}}{{/languages}}, {{#certifications}}{{.}}{{/certifications}}
{{#projects}} {{name}} {{description}} {{/projects}}
{{#photo}}<img src="{{photo}}">{{/photo}}
Bölüm başka alan içermiyorsa {{#hasSummary}}, {{#hasExperience}}, {{#hasEducation}}, {{#hasSkills}}, {{#hasLanguages}}, {{#hasCertifications}}, {{#hasProjects}} ile gizlenebilir.`;

const present = (v: string | null | undefined): string => v?.trim() ?? '';

/**
 * Şablon deneyimde hem `{{description}}` hem `{{#bullets}}` kullanıyorsa açıklama boş verilir; yoksa aynı metin iki kez
 * basılır (`description` maddelerin birleşimidir).
 */
export function layoutView(cv: StructuredCv, photo: string | null, usesBullets = false) {
  const experience = cv.experience.map((e) => ({
    role: e.role,
    company: e.company,
    period: present(e.period),
    location: present(e.location),
    bullets: e.bullets,
    description: usesBullets ? '' : e.bullets.join(' '),
  }));
  return {
    name: cv.name,
    title: present(cv.title),
    email: present(cv.contact.email),
    phone: present(cv.contact.phone),
    location: present(cv.contact.location),
    links: cv.contact.links,
    summary: present(cv.summary),
    hasSummary: !!present(cv.summary),
    experience,
    hasExperience: experience.length > 0,
    education: cv.education.map((e) => ({ school: e.school, degree: present(e.degree), period: present(e.period) })),
    hasEducation: cv.education.length > 0,
    skills: cv.skills,
    skillsText: cv.skills.join(', '),
    hasSkills: cv.skills.length > 0,
    languages: cv.languages,
    hasLanguages: cv.languages.length > 0,
    certifications: cv.certifications,
    hasCertifications: cv.certifications.length > 0,
    projects: cv.projects.map((p) => ({ name: p.name, description: present(p.description) })),
    hasProjects: cv.projects.length > 0,
    photo: photo ?? '',
  };
}

/** Şablonu yapısal CV ile doldurur; bütün değerler HTML'e kaçışlı yazılır. */
export function fillLayout(html: string, cv: StructuredCv, photo: string | null): string {
  const usesBullets = tagNames(Mustache.parse(html) as unknown[]).includes('#bullets');
  return Mustache.render(html, layoutView(cv, photo, usesBullets), {}, { escape: escapeHtml });
}

const FORBIDDEN: { pattern: RegExp; reason: string }[] = [
  { pattern: /<script\b/i, reason: 'betik içeriyor' },
  { pattern: /<(iframe|object|embed|link|base|form)\b/i, reason: 'izin verilmeyen etiket içeriyor' },
  { pattern: /<meta\b(?!\s+charset\s*=\s*['"]?[\w-]+['"]?\s*\/?>)/i, reason: 'izin verilmeyen etiket içeriyor' },
  { pattern: /\son[a-z]+\s*=/i, reason: 'olay özniteliği içeriyor' },
  { pattern: /@import\b/i, reason: 'dış stil yüklüyor' },
  { pattern: /(?:url\(\s*['"]?|(?:src|href)\s*=\s*['"]?)\s*(?:https?:|\/\/|file:|javascript:)/i, reason: 'dış kaynak yüklüyor' },
  { pattern: /\{\{\s*[{&>!=]/, reason: 'izin verilmeyen şablon etiketi içeriyor' },
];

/**
 * Yapay zekânın ürettiği şablonu denetler: güvenli mi, değişen alanları (unvan, özet, deneyim, beceriler) şablondan mı
 * alıyor ve orijinal içerikle doldurulunca boşta etiket kalıyor mu. Sorun yoksa null döner.
 */
export function layoutProblem(html: string, cv: StructuredCv): string | null {
  if (html.length > MAX_LAYOUT_HTML) return 'şablon çok uzun';
  for (const { pattern, reason } of FORBIDDEN) if (pattern.test(html)) return `şablon ${reason}`;
  let tags: string[];
  try {
    tags = tagNames(Mustache.parse(html) as unknown[]);
  } catch {
    return 'şablon sözdizimi bozuk';
  }
  const uses = (tag: string) => tags.includes(tag);
  if (cv.experience.length && !uses('#experience')) return 'deneyimler şablondan gelmiyor';
  if (cv.experience.length && !uses('namerole')) return 'deneyim unvanları şablondan gelmiyor';
  if (cv.experience.length && !uses('namedescription') && !uses('#bullets')) return 'deneyim açıklamaları şablondan gelmiyor';
  if (cv.skills.length && !uses('#skills') && !uses('nameskillsText')) return 'beceriler şablondan gelmiyor';
  if (present(cv.summary) && !uses('namesummary')) return 'özet şablondan gelmiyor';
  if (present(cv.title) && !uses('nametitle')) return 'unvan şablondan gelmiyor';
  if (fillLayout(html, cv, null).includes('{{')) return 'şablonda doldurulmamış etiket kaldı';
  return null;
}

/** Şablonun `font-family` bildirimlerinde geçen gömülü yazı tipleri. */
export function layoutFonts(html: string): string[] {
  const declared = [...html.matchAll(/font-family\s*:\s*([^;}<>]+)/gi)].flatMap((m) => m[1].split(',').map((f) => f.trim().replace(/^['"]+|['"]+$/g, '')));
  return Object.keys(CV_FONTS).filter((family) => declared.some((d) => d.toLowerCase() === family.toLowerCase()));
}

function tagNames(tokens: unknown[]): string[] {
  return tokens.flatMap((token) => {
    const [type, name, , , children] = token as unknown[];
    return [`${String(type)}${String(name)}`, ...(Array.isArray(children) ? tagNames(children) : [])];
  });
}

function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}
