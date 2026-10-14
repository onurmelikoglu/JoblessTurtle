import { fold } from './text';

/** TR/EN yazım ve dil varyantlarını ortak sözcüklere indirger. */
const TOKEN_MAP: Record<string, string> = {
  kreatif: 'creative',
  yaratici: 'creative',
  direktor: 'director',
  direktoru: 'director',
  direktorlugu: 'director',
  yonetmen: 'director',
  yonetmeni: 'director',
  sanat: 'art',
  lider: 'lead',
  lideri: 'lead',
  ekip: 'team',
  mudur: 'manager',
  muduru: 'manager',
  yoneticisi: 'manager',
  yonetici: 'manager',
  produktor: 'producer',
  produktoru: 'producer',
  yapimci: 'producer',
  yapimcisi: 'producer',
  icerik: 'content',
  tasarim: 'design',
  tasarimci: 'designer',
  tasarimcisi: 'designer',
  kidemli: 'senior',
  bas: 'head',
  basi: 'head',
  sorumlusu: 'lead',
  metin: 'copy',
  yazari: 'writer',
  cd: 'creative director',
  acd: 'associate creative director',
  ecd: 'executive creative director',
  gelistirici: 'developer',
  gelistiricisi: 'developer',
  yazilimci: 'software developer',
  yazilim: 'software',
  muhendis: 'engineer',
  muhendisi: 'engineer',
  mobil: 'mobile',
  uzman: 'specialist',
  uzmani: 'specialist',
  analist: 'analyst',
  analisti: 'analyst',
  danisman: 'consultant',
  danismani: 'consultant',
  koordinator: 'coordinator',
  koordinatoru: 'coordinator',
  editor: 'editor',
  editoru: 'editor',
  sosyal: 'social',
  medya: 'media',
  pazarlama: 'marketing',
  satis: 'sales',
  urun: 'product',
  proje: 'project',
  veri: 'data',
  bilimci: 'scientist',
  bilimcisi: 'scientist',
  grafik: 'graphic',
  dijital: 'digital',
  marka: 'brand',
  stajyer: 'intern',
  asistan: 'assistant',
  asistani: 'assistant',
  sr: 'senior',
  jr: 'junior',
};

/** Unvanın anlamını değiştirmeyen dolgu sözcükleri: "Mobile Application Developer" ile "Mobile Developer" aynı roldür. */
const FILLER_TOKENS = new Set(['application', 'applications', 'app', 'apps', 'uygulama', 'uygulamalari']);

/** "Sr." ve "Jr." gibi kısaltmaların noktası; sözcük içindeki nokta (node.js) korunur. */
const EDGE_DOTS = /^\.+|\.+$/g;

const DOWNGRADE_PREFIXES = ['associate', 'assistant', 'yardimci', 'junior', 'intern'];

export function normalizeTitle(title: string | null | undefined): string {
  const tokens = fold(title)
    .split(' ')
    .map((t) => t.replace(EDGE_DOTS, ''))
    .filter((t) => t && !FILLER_TOKENS.has(t))
    .map((t) => TOKEN_MAP[t] ?? t);
  return tokens.join(' ').replace(/\s+/g, ' ').trim();
}

function containsPhrase(haystack: string, needle: string): number {
  if (!needle) return -1;
  const h = ` ${haystack} `;
  const idx = h.indexOf(` ${needle} `);
  return idx;
}

export type TitleMatch = 'exact' | 'adjacent' | 'excluded' | 'none';

export interface TitleRules {
  exactTitles: string[];
  adjacentTitles: string[];
  excludedTitles: string[];
}

export interface TitleClassification {
  match: TitleMatch;
  term?: string;
  note?: string;
}

/**
 * Unvan sınıflandırma. Hariç liste önce uygulanır. Exact eşleşme "associate/assistant"
 * gibi bir önekle geliyorsa yakın role düşürülür (otomatik exact sayılmaz).
 */
export function classifyTitle(title: string, rules: TitleRules): TitleClassification {
  const norm = normalizeTitle(title);
  for (const ex of rules.excludedTitles) {
    const n = normalizeTitle(ex);
    if (n && containsPhrase(norm, n) >= 0) return { match: 'excluded', term: ex };
  }
  for (const t of rules.exactTitles) {
    const n = normalizeTitle(t);
    const idx = containsPhrase(norm, n);
    if (n && idx >= 0) {
      const before = norm.slice(0, Math.max(0, idx)).trim().split(' ');
      const prev = before[before.length - 1];
      if (prev && DOWNGRADE_PREFIXES.includes(prev)) {
        return { match: 'adjacent', term: t, note: `"${prev}" öneki nedeniyle yakın rol` };
      }
      return { match: 'exact', term: t };
    }
  }
  for (const t of rules.adjacentTitles) {
    const n = normalizeTitle(t);
    if (n && containsPhrase(norm, n) >= 0) return { match: 'adjacent', term: t };
  }
  return { match: 'none' };
}
