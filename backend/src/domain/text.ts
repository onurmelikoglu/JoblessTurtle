/** Türkçe karakterleri sadeleştirip küçük harfe çevirir; noktalama boşluğa dönüşür. */
export function fold(input: string | null | undefined): string {
  if (!input) return '';
  return input
    .replace(/İ/g, 'i')
    .replace(/I/g, 'ı')
    .toLowerCase()
    .replace(/ı/g, 'i')
    .replace(/ş/g, 's')
    .replace(/ğ/g, 'g')
    .replace(/ü/g, 'u')
    .replace(/ö/g, 'o')
    .replace(/ç/g, 'c')
    .replace(/â/g, 'a')
    .replace(/î/g, 'i')
    .replace(/û/g, 'u')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9@.+\s-]/g, ' ')
    .replace(/[-_/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeCompanyName(name: string): string {
  return fold(name)
    .replace(/\b(a\.?s\.?|ltd\.?|sti\.?|limited|sirketi|anonim|ticaret|san\.?|tic\.?|inc\.?|llc|gmbh|co\.?)\b/g, ' ')
    .replace(/[.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  let v = input.trim().toLowerCase();
  if (!v) return null;
  if (v.includes('@') && !v.includes('/')) v = v.split('@')[1];
  v = v.replace(/^[a-z]+:\/\//, '').replace(/^www\./, '');
  v = v.split(/[/?#:]/)[0];
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(v)) return null;
  return v;
}

export function truncate(s: string | null | undefined, n: number): string | null {
  if (!s) return s ?? null;
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function stripHtml(html: string | null | undefined): string {
  if (!html) return '';
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

const TURKISH_URL = /\.tr(?=[/:?#]|$)|\/tr(?=[/_?#-]|$)|[?&](?:lang|hl|locale|language)=tr\b|\btr[-_]tr\b/i;

export function isTurkishUrl(url: string | null | undefined): boolean {
  return !!url && TURKISH_URL.test(url);
}

/** Türkiye sayfası varsa onu, yoksa ilk geçerli bağlantıyı döndürür. */
export function preferTurkishUrl(urls: (string | null | undefined)[]): string | null {
  const valid = urls.filter((u): u is string => !!u);
  return valid.find(isTurkishUrl) ?? valid[0] ?? null;
}

const AD_WORD = /(?<![\p{L}])[İiI]lan(\p{L}*)/gu;
const DUPLICATE_POSITION = /([Pp]ozisyon\p{L}*)\s+pozisyon(\p{L}*)/gu;
const ROUNDING_STOP = /[aeAE]/;

function followRounding(suffix: string) {
  let rounding = true;
  let out = '';
  for (const ch of suffix) {
    if (ROUNDING_STOP.test(ch)) rounding = false;
    out += rounding && ch === 'ı' ? 'u' : ch;
  }
  return out;
}

/**
 * Bazı firmalar başvuru metninde "ilan" kelimesini istemez. Kelime ve çekimleri "pozisyon" ile değiştirilir
 * ("ilanınıza" → "pozisyonunuza"); ünlü uyumu korunur. Kalıp, konu ve taslak metinlerine uygulanır.
 */
export function replaceAdWord(text: string): string {
  return text
    .replace(AD_WORD, (match, suffix: string) => `${match[0] === 'İ' || match[0] === 'I' ? 'Pozisyon' : 'pozisyon'}${followRounding(suffix)}`)
    .replace(DUPLICATE_POSITION, (_, __, second: string) => `pozisyon${second}`);
}
