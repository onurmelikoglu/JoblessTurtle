import { fold } from './text';
import { isInTurkey, workScopeOf } from './geo';

export const APPLICATION_LANGUAGES = ['tr', 'en'] as const;
export type ApplicationLanguage = (typeof APPLICATION_LANGUAGES)[number];

export const isApplicationLanguage = (value: unknown): value is ApplicationLanguage => (APPLICATION_LANGUAGES as readonly unknown[]).includes(value);

export type LanguageReason = 'company_choice' | 'abroad_listing' | 'listing_text' | 'foreign_company' | 'turkish_company' | 'default';

export const LANGUAGE_REASON_TEXT: Record<LanguageReason, string> = {
  company_choice: 'Bu firma için seçtiğin dil',
  abroad_listing: 'İlan yurt dışında',
  listing_text: 'İlan metninin dili',
  foreign_company: 'Yabancı firma: Türkiye ofisi ya da Türkçe sitesi bulunamadı',
  turkish_company: "Firma Türkiye'de",
  default: 'Varsayılan dil',
};

export const ENGLISH_CV_MISSING = 'İngilizce CV yok: yabancı firmaya otomatik gönderilmez. Profil › Belgeler’den İngilizce CV yükle ya da bu taslağı kontrol edip kendin gönder.';

export interface LanguageSignals {
  companyChoice?: string | null;
  jobTitle?: string | null;
  jobDescription?: string | null;
  jobLocation?: string | null;
  jobWorkMode?: string | null;
  domain?: string | null;
  siteLanguage?: string | null;
  officeTexts?: string[];
}

export interface LanguageDecision {
  language: ApplicationLanguage;
  reason: LanguageReason;
}

const TURKISH_LETTERS = /[çğıöşüÇĞİÖŞÜ]/g;
const TURKISH_WORDS = new Set('ve bir icin ile olarak olan veya bu da de en az yil deneyim deneyimli tecrubeli arayan ariyoruz araniyor aranmaktadir sahip bilgi bilgisi becerisi gibi uzere olmak yapmak calisma calisacak sirket sirketimiz ekibimize ekip takim pozisyon is gorev sorumluluklar nitelikler tercihen konusunda alaninda mezun universite'.split(' '));
const ENGLISH_WORDS = new Set('the and for with you your our we will are is to of in on a an as be have has who what this that from at experience team skills required requirements responsibilities preferred knowledge working work years strong ability looking join role develop building build'.split(' '));
const MIN_WORDS_FOR_TEXT_LANGUAGE = 25;
const LANGUAGE_MARGIN = 1.5;

/** Metnin dili; kısa ya da karışık metinde null. Türkçe harfler ve sık kullanılan sözcükler sayılır. */
export function textLanguage(text: string | null | undefined): ApplicationLanguage | null {
  const raw = text?.trim() ?? '';
  if (!raw) return null;
  const words = fold(raw).split(/[^a-z]+/).filter(Boolean);
  if (words.length < MIN_WORDS_FOR_TEXT_LANGUAGE) return null;
  const turkishLetters = raw.match(TURKISH_LETTERS)?.length ?? 0;
  const turkish = words.filter((w) => TURKISH_WORDS.has(w)).length + turkishLetters / 4;
  const english = words.filter((w) => ENGLISH_WORDS.has(w)).length;
  if (turkish >= english * LANGUAGE_MARGIN && turkish > 0) return 'tr';
  if (english >= turkish * LANGUAGE_MARGIN && english > 0) return 'en';
  return null;
}

const isTurkishDomain = (domain: string | null | undefined) => !!domain && /\.tr$/i.test(domain.trim());

/**
 * Başvurunun dili, güç sırasıyla: kullanıcının firma için seçtiği dil → yurt dışı ilanı → ilan metninin dili →
 * firmanın Türkiye bağı (ofis, .tr alan adı, Türkçe site) → yabancı firma (bilinen ofislerin hepsi yurt dışında ya da
 * sitesi yalnız İngilizce) → Türkçe.
 */
export function applicationLanguageOf(signals: LanguageSignals): LanguageDecision {
  if (isApplicationLanguage(signals.companyChoice)) return { language: signals.companyChoice, reason: 'company_choice' };
  if (workScopeOf(signals.jobLocation, signals.jobWorkMode) === 'abroad') return { language: 'en', reason: 'abroad_listing' };
  const listing = textLanguage([signals.jobTitle, signals.jobDescription].filter(Boolean).join('\n'));
  if (listing) return { language: listing, reason: 'listing_text' };
  const offices = (signals.officeTexts ?? []).filter((t) => t.trim());
  const site = signals.siteLanguage ? fold(signals.siteLanguage).slice(0, 2) : null;
  if (offices.some((t) => isInTurkey(t)) || isTurkishDomain(signals.domain) || site === 'tr') return { language: 'tr', reason: 'turkish_company' };
  const officesAbroad = offices.length > 0 && offices.every((t) => workScopeOf(t) === 'abroad');
  if (officesAbroad || site === 'en') return { language: 'en', reason: 'foreign_company' };
  return { language: 'tr', reason: 'default' };
}

/** İngilizce yazıda İngilizce CV ekli mi; ek yoksa ya da CV Türkçeyse taslak otomatik gönderilmez. */
export function englishCvMissing(language: string, attached: { type: string; language: string }[]): boolean {
  return language === 'en' && !attached.some((d) => d.type === 'cv' && d.language === 'en');
}
