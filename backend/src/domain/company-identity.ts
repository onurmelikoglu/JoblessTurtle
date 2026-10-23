import { normalizeCompanyName, normalizeDomain } from './text';

/**
 * Aynı firmanın farklı adla ya da alan adıyla açılmış kayıtlarını tanır: "Kartal Ödeme (İstanbul)" ile
 * "Kartal Ödeme (Türkiye / İstanbul)", kartalodeme.com ile kartalodeme.com.tr, "DALGA Agency (İstanbul)" ile
 * "DALGA (The Brandtech Group) – İstanbul" aynı firmadır. "Unda Studio" ile "Unda Sigorta" değildir: ad çekirdeği
 * bütün olarak karşılaştırılır, ilk sözcük tek başına yetmez.
 */
const PLACE_WORDS = new Set([
  'turkiye', 'turkey', 'tr', 'istanbul', 'ankara', 'izmir', 'kocaeli', 'bursa', 'antalya', 'avrupa', 'anadolu', 'yakasi', 'europe', 'emea',
  'merkez', 'genel', 'mudurluk', 'mudurlugu', 'ofis', 'office', 'kampus', 'kampusu', 'subesi', 'sube',
]);
const GENERIC_WORDS = new Set([
  'group', 'grup', 'grubu', 'holding', 'teknoloji', 'teknolojileri', 'technology', 'technologies', 'tech', 'global', 'international', 'agency', 'ajans', 'ajansi',
  'the', 've', 'and', 'company', 'co', 'limited', 'sirket', 'sirketi', 'ticaret', 'sanayi', 'hizmetleri', 'as', 'inc', 'ltd', 'llc', 'gmbh',
]);
const TWO_LEVEL_SUFFIXES = new Set(['com.tr', 'net.tr', 'org.tr', 'gen.tr', 'web.tr', 'biz.tr', 'info.tr', 'bel.tr', 'edu.tr', 'k12.tr', 'gov.tr', 'av.tr', 'co.uk', 'org.uk', 'com.au', 'co.jp', 'com.br']);
/** Birçok firmanın alt alan adı olarak kullandığı barındırma ve platform alanları: kökleri firma kimliği değildir. */
const SHARED_HOST_ROOTS = new Set([
  'github', 'gitlab', 'wixsite', 'blogspot', 'wordpress', 'webflow', 'netlify', 'vercel', 'herokuapp', 'google', 'sites', 'medium', 'notion', 'tumblr',
  'squarespace', 'carrd', 'linkedin', 'instagram', 'facebook', 'kariyer', 'business', 'myshopify', 'ikas', 'ticimax', 'firebaseapp', 'pages',
]);
const MIN_KEY_LENGTH = 3;
const MIN_DOMAIN_ROOT_LENGTH = 4;
const PARENTHESES = /\(([^)]*)\)/g;

function core(text: string): string {
  return normalizeCompanyName(text)
    .split(' ')
    .filter((token) => token && !PLACE_WORDS.has(token) && !GENERIC_WORDS.has(token))
    .join(' ');
}

/** Firma adından çıkan ad anahtarları: parantez dışı ad ve parantez içindeki diğer ad ("Yosun Istanbul (Yosun Engage)"). */
export function nameKeysOf(name: string): string[] {
  const inner = [...name.matchAll(PARENTHESES)].map((m) => m[1]);
  const outer = name.replace(PARENTHESES, ' ');
  return [...new Set([outer, ...inner].map(core).filter((key) => key.length >= MIN_KEY_LENGTH))];
}

/** Alan adının kayıtlı kökü: www.kartalodeme.com.tr ve kartalodeme.com → "kartalodeme"; dalga.agency → "dalga". */
export function domainRootOf(domain: string | null | undefined): string | null {
  const host = normalizeDomain(domain);
  if (!host) return null;
  const labels = host.split('.');
  const suffixLength = labels.length > 2 && TWO_LEVEL_SUFFIXES.has(labels.slice(-2).join('.')) ? 2 : 1;
  const root = labels[labels.length - suffixLength - 1];
  return root && root.length >= MIN_DOMAIN_ROOT_LENGTH && !SHARED_HOST_ROOTS.has(root) ? root : null;
}

export interface CompanyIdentity {
  id: string;
  name: string;
  canonicalDomain?: string | null;
  website?: string | null;
}

export function identityKeysOf(company: Omit<CompanyIdentity, 'id'>): string[] {
  const roots = [domainRootOf(company.canonicalDomain), domainRootOf(company.website)].filter((r): r is string => !!r);
  return [...new Set([...nameKeysOf(company.name).map((k) => `n:${k}`), ...roots.map((r) => `d:${r}`)])];
}

/** Bir firma kümesi üzerinde kimlik araması: kayıt kimliği, ad anahtarı ya da alan adı kökü eşleşirse aynı firmadır. */
export class CompanyIdentityIndex<T extends CompanyIdentity> {
  private readonly byId = new Map<string, T>();
  private readonly byKey = new Map<string, T>();

  constructor(companies: T[]) {
    for (const company of companies) {
      this.byId.set(company.id, company);
      for (const key of identityKeysOf(company)) if (!this.byKey.has(key)) this.byKey.set(key, company);
    }
  }

  match(company: CompanyIdentity): T | null {
    const own = this.byId.get(company.id);
    if (own) return own;
    for (const key of identityKeysOf(company)) {
      const found = this.byKey.get(key);
      if (found) return found;
    }
    return null;
  }

  get size(): number {
    return this.byId.size;
  }
}
