import { fold } from './text';

/**
 * İlan sitelerinde ve web aramasında adı gizlenmiş işveren: "Gizli Firma", "Firma Adı Gizli", "Firma Bilgisi Gizli",
 * "Sektöründe Lider Firma (gizli firma)", "Confidential". Bu ilanlar çalışma alanına firma olarak aktarılmaz; ad yanında
 * gerçek ad da yazıyorsa ("Gizli Firma / KARTAL ÇELİK …") gerçek ad kullanılır.
 */
const HIDDEN_MARKERS = [
  /\bgizli (firma|sirket|isveren|kurum)\b/,
  /\b(firma|sirket|isveren|kurum) (adi|ismi|bilgisi|bilgileri|unvani) gizli/,
  /\b(isim|isveren|unvan) gizli\b/,
  /\bconfidential\b/,
  /\b(company|employer) (name )?(is )?(hidden|undisclosed)\b/,
  /^gizli$/,
];

const DESCRIPTOR_WORDS = new Set(
  (
    'gizli firma firmasi sirket sirketi isveren kurum kurumu company employer confidential hidden undisclosed adi ismi bilgisi bilgileri ' +
    'sektorunde sektorunun sektor lider onde gelen buyuk kurumsal bir taninmis uluslararasi global yerli turk ulusal alaninda alanindaki faaliyet gosteren ' +
    'hizmet veren basarili kuruluşu kurulusu holding grup grubu'
  ).split(' '),
);
const PARENTHESES = /\([^)]*\)/g;
const SEPARATORS = /\s*(?:\/|\||–|—|\s-\s)\s*/;
const MIN_NAME_WORD_LENGTH = 3;

const isHiddenText = (text: string) => HIDDEN_MARKERS.some((marker) => marker.test(fold(text).replace(/\s+/g, ' ').trim()));

const hasRealName = (part: string) =>
  fold(part)
    .split(/[^a-z0-9]+/)
    .some((word) => word.length >= MIN_NAME_WORD_LENGTH && !DESCRIPTOR_WORDS.has(word));

/** Firmanın görünür adı; ad tamamen gizliyse null. */
export function visibleCompanyName(name: string | null | undefined): string | null {
  const raw = name?.trim();
  if (!raw) return null;
  if (!isHiddenText(raw)) return raw;
  const parts = raw.replace(PARENTHESES, ' ').split(SEPARATORS).map((p) => p.trim()).filter(Boolean);
  return parts.find((p) => !isHiddenText(p) && hasRealName(p)) ?? null;
}

export const isHiddenCompany = (name: string | null | undefined) => visibleCompanyName(name) === null;
