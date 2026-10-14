/**
 * İş alarmı mailleri: Kariyer.net, LinkedIn, Indeed gibi siteler kullanıcının kurduğu alarma uyan ilanları kendisi
 * postayla gönderir. Bu siteler otomatik taramayı engellediği için (CAPTCHA) en eksiksiz ve en sağlam ilan kaynağı
 * budur: site ilanı kendi bildirir, biz yalnızca kullanıcının gelen kutusundaki bildirimi okuruz.
 */
import { CITY_SELECTION_SEPARATOR } from './geo';
import { fold } from './text';

export const JOB_ALERT_SOURCE = 'job_alert';

const SITES: { domain: string; platform: string }[] = [
  { domain: 'kariyer.net', platform: 'Kariyer.net' },
  { domain: 'linkedin.com', platform: 'LinkedIn' },
  { domain: 'indeed.com', platform: 'Indeed' },
  { domain: 'glassdoor.com', platform: 'Glassdoor' },
  { domain: 'glassdoor.com.tr', platform: 'Glassdoor' },
  { domain: 'secretcv.com', platform: 'Secretcv' },
  { domain: 'eleman.net', platform: 'Eleman.net' },
  { domain: 'yenibiris.com', platform: 'Yenibiris' },
  { domain: 'youthall.com', platform: 'Youthall' },
  { domain: 'toptalent.co', platform: 'Toptalent' },
  { domain: 'isinolsun.com', platform: 'İşin Olsun' },
  { domain: 'jooble.org', platform: 'Jooble' },
];

/** Gönderenin alan adı bilinen bir iş sitesine aitse sitenin adı (alt alan adları dahil: jobalerts-noreply@linkedin.com, alert@jobalert.indeed.com). */
export function alertPlatformOf(fromEmail: string | null | undefined): string | null {
  const host = (fromEmail ?? '').toLowerCase().split('@')[1];
  if (!host) return null;
  return SITES.find((s) => host === s.domain || host.endsWith(`.${s.domain}`))?.platform ?? null;
}

const LISTING_URL: RegExp[] = [
  /(^|\.)kariyer\.net\/is-ilani\//i,
  /(^|\.)linkedin\.com\/(comm\/)?jobs\/view\//i,
  /(^|\.)indeed\.com\/.*[?&](jk|vjk)=/i,
  /(^|\.)glassdoor\.[a-z.]+\/(job-listing|partner\/joblisting)/i,
  /(^|\.)secretcv\.com\/.+is-ilanlari-\d+/i,
  /(^|\.)eleman\.net\/is-ilani\//i,
  /(^|\.)yenibiris\.com\/is-ilani/i,
];

/** Bağlantı, bilinen bir sitenin tekil ilan sayfasına mı gidiyor? İzleme bağlantıları (tıklama sayaçları) tanınmaz. */
export function isListingUrl(url: string): boolean {
  const bare = url.replace(/^https?:\/\//i, '');
  return LISTING_URL.some((re) => re.test(bare));
}

/** İş sitelerinin ilan içermeyen postaları: hesap, güvenlik, başvuru onayı, mesaj ve bağlantı bildirimleri. Türkçe harfler sadeleştirilmiş metinde aranır. */
const NOT_AN_ALERT = /(sifre|password|dogrula|verify|verification|guvenlik kodu|security code|basvuru(nuz|n)? (alindi|alinmistir|ulasti|iletildi|tamamlandi|degerlendiril|sonuc)|your application|application (was|has been)|fatura|invoice|hos geldin|welcome to|uyeligin|profilini? (goruntule|inceledi)|viewed your profile|mesaj gonderdi|sent you a message|baglanti istegi|invitation to connect|accepted your)/;
const ALERT_SUBJECT = /(is alarm|ilan|job alert|jobs? for you|new jobs?|yeni is|pozisyon|is firsat|sana uygun|sana ozel|onerilen|recommended|is hiring|ise alim yapiyor|kariyer firsat)/;

/** Posta ilan duyurusu mu: tanınan bir ilan bağlantısı içeriyorsa ya da konusu alarm gibiyse evet; hesap/başvuru bildirimiyse hayır. */
export function looksLikeAlert(mail: { subject: string; listingLinks: number }): boolean {
  const subject = `${fold(mail.subject)} `;
  if (NOT_AN_ALERT.test(subject)) return false;
  return mail.listingLinks > 0 || ALERT_SUBJECT.test(subject);
}

const SKIPPED_LINK = /(unsubscribe|abonelikten|abonelik|bildirim-?ayar|email-?preferences|settings|ayarlar|preferences|privacy|gizlilik|kvkk|cerez|cookie|terms|kosullar|help|yardim|destek|support|facebook\.com|twitter\.com|\/\/x\.com|instagram\.com|youtube\.com|tiktok\.com|apps\.apple\.com|play\.google\.com|itunes\.apple\.com)/;
const MAX_LINKS = 80;
const MAX_LINK_TEXT = 160;

export interface AlertLink {
  ref: string;
  url: string;
  text: string;
}

/**
 * Postadaki bağlantılardan ilan olabilecekleri seçer ve "L1", "L2"… diye numaralar. Abonelik, ayar, sosyal medya ve
 * mağaza bağlantıları atılır; aynı adrese giden bağlantılar tek kayıtta birleşir (en uzun bağlantı metni kalır).
 */
export function alertLinks(anchors: { href: string; text: string }[]): AlertLink[] {
  const byUrl = new Map<string, string>();
  for (const anchor of anchors) {
    const url = anchor.href.trim();
    if (!/^https?:\/\//i.test(url) || SKIPPED_LINK.test(url.toLowerCase())) continue;
    const text = anchor.text.replace(/\s+/g, ' ').trim().slice(0, MAX_LINK_TEXT);
    if (SKIPPED_LINK.test(fold(text))) continue;
    const known = byUrl.get(url);
    if (known === undefined || text.length > known.length) byUrl.set(url, text);
  }
  return [...byUrl]
    .filter(([url, text]) => text.length >= 3 || isListingUrl(url))
    .slice(0, MAX_LINKS)
    .map(([url, text], i) => ({ ref: `L${i + 1}`, url, text }));
}

/** Alarm kurulumunda gösterilen pozisyon sayısı sınırı. */
export const MAX_ALERT_TITLES = 12;

const PART_OF_CITY = /\s*\(.*\)\s*$/;

/**
 * Kayıtlı şehir seçimi ("İstanbul; İstanbul (Anadolu Yakası); Kocaeli") alarm kurulumunun başlangıç seçimine iner:
 * şehrin tamamı seçiliyse yaka ayrıntıları düşer, yalnızca bir yaka seçiliyse yaka kalır.
 */
export function alertCities(selection: string | null | undefined): string[] {
  const parts = (selection ?? '').split(CITY_SELECTION_SEPARATOR).map((p) => p.trim()).filter(Boolean);
  const whole = new Set(parts.filter((p) => !PART_OF_CITY.test(p)).map(fold));
  const cities = new Map<string, string>();
  for (const part of parts) {
    if (PART_OF_CITY.test(part) && whole.has(fold(part.replace(PART_OF_CITY, '')))) continue;
    if (!cities.has(fold(part))) cities.set(fold(part), part);
  }
  return [...cities.values()];
}

/** Etkin profillerin tam unvanları ve şehirleri, tekrarsız; alarm kurulumunda seçenek olarak gösterilir. */
export function alertChoices(profiles: { exactTitles: string[]; cities: string[] }[]): { titles: string[]; cities: string[] } {
  const titles = new Map<string, string>();
  const cities = new Map<string, string>();
  for (const profile of profiles) {
    for (const raw of profile.exactTitles) {
      const title = raw.trim();
      if (title && !titles.has(fold(title)) && titles.size < MAX_ALERT_TITLES) titles.set(fold(title), title);
    }
    for (const city of profile.cities) if (!cities.has(fold(city))) cities.set(fold(city), city);
  }
  return { titles: [...titles.values()], cities: [...cities.values()] };
}

export interface AlertListing {
  title: string;
  company: string;
  location?: string | null;
  workMode?: 'onsite' | 'hybrid' | 'remote' | 'unknown';
  link: string;
}

/** Modelin döndürdüğü ilanları postadaki gerçek bağlantılara bağlar; postada olmayan bir bağlantıya işaret eden ilan atılır. */
export function linkedListings(listings: AlertListing[], links: AlertLink[]): (AlertListing & { url: string })[] {
  const urlOf = new Map(links.map((l) => [l.ref, l.url]));
  const seen = new Set<string>();
  const out: (AlertListing & { url: string })[] = [];
  for (const listing of listings) {
    const url = urlOf.get(listing.link.trim());
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ ...listing, url });
  }
  return out;
}
