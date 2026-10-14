import { normalizeDomain } from './text';

const HR_LOCAL = /^(ik|hr|insankaynaklari|insan\.?kaynaklari|kariyer|career|careers|jobs|job|is|isbasvuru|basvuru|isealim|ise\.?alim|apply|hiring|recruitment|recruiting|recruiters?|talent|yetenek|cv|people|humanresources|join|joinus|workwithus)([._-].*)?$/;
const GENERAL_LOCAL = /^(info|bilgi|hello|hey|hi|merhaba|contact|contacto|contactus|iletisim|office|ofis|studio|mail|admin|team|ekip)([._-].*)?$/;
const NOT_HR_LOCAL = /^(sales|satis|newbusiness|new\.business|business|bd|pazarlama|marketing|press|basin|pr|media|medya|billing|muhasebe|finance|help|yardim|order|siparis|webmaster|postmaster|abuse|security|ads|reklam|ir|etik|ethics|egitmen|instructor)([._-].*)?$/;
const NOT_HR_FRAGMENT = /destek|support|customer|musteri|kvkk|privacy|gizlilik|legal|hukuk|compliance|noreply|no-reply|donotreply|sikayet|complaint|fatura|invoice|kurumsaliletisim|haberlesme|kalite|quality|partner|affil|monetiz|inovasyon|innovation|yatirimci|investor|sponsor|bddk|kisiselveri|kisisel\.?veri|phishing|fraud|dolandirici|sahtekar|reasonable|accommodation|sourcing|tebligat|muhaberat|veri\.?koruma|dataprotection|data\.?protection|gdpr|dpo|aydinlatma/;
const PLACEHOLDER_LOCAL = /^(name|name\.surname|firstname\.lastname|ad\.?soyad|isim\.?soyisim|ornek|example|sample|test|email|eposta|user|kullanici|john\.doe|xxx|abc)$/;
const KEP_DOMAIN = /(^|\.)kep\.tr$/;
const PLACEHOLDER_DOMAIN = /^(email|example|domain|company|yourcompany|organisation|organization|sirket|firma|mail|test|ornek)\.(com|org|net|com\.tr)$/;
export const STRONG_HR_LOCAL = /^(ik|hr|kariyer|career|careers|jobs|job|isealim|ise\.?alim|recruitment|recruiting|recruiter|talent|cv|basvuru|isbasvuru|apply|hiring|yetenek)([._-].*)?$/;
const KIND_SCORE: Record<string, number> = { job_apply: 400, official_hr: 300, named_recruiter: 150, general: 100 };
const STRONG_HR_BONUS = 40;
const OTHER_HR_BONUS = 20;
const DOMAIN_MATCH_BONUS = 60;
const VERIFIED_BONUS = 10;
const PREFER_VERIFIED_BONUS = 50;
/**
 * Teslim kestirimi temel orandan ne kadar saparsa puan o oranda değişir: yüzde 10'luk fark 40 puan eder. Aynı türdeki
 * adresleri yeniden sıralamaya yeter; İK adresini genel adresin gerisine ancak çok büyük bir fark (yaklaşık yüzde 60) düşürür.
 */
const DELIVERY_WEIGHT = 400;
export const PERSON_LOCAL = /^[a-zçğıöşü]{2,}[._-][a-zçğıöşü]{2,}$/;
const ESCAPE_PREFIX = /^(?:u003[ce]|%20|%3[ce]|\/+)+/i;

export type ContactKind = 'official_hr' | 'job_apply' | 'general' | 'named_recruiter' | 'guessed' | 'group_hr' | 'candidate_hr' | 'non_hr' | 'other';

export const GROUP_HR_KIND = 'group_hr';
export const CANDIDATE_HR_KIND = 'candidate_hr';
export const SUGGESTED_ONLY_KINDS = [GROUP_HR_KIND, CANDIDATE_HR_KIND];

const UNVERIFIABLE_HOST = /(?:^|\.)((linkedin|facebook|twitter|x|instagram|zoominfo|rocketreach|kompass|dnb|opencorporates|glassdoor|indeed)\.com|apollo\.io|find\.com\.tr|imes\.org|sirketler\.net|firmarehberi\.com|chrome\.google\.com|play\.google\.com|apps\.apple\.com)$/i;

/** Sosyal medya ve üçüncü taraf rehberlerdeki adresler eski ve doğrulanamaz olabilir; firma alan adı dışındakiler yalnızca öneri sayılır. */
export function isUnverifiableSource(sourceUrl: string | null | undefined): boolean {
  try {
    return !!sourceUrl && UNVERIFIABLE_HOST.test(new URL(sourceUrl).hostname);
  } catch {
    return false;
  }
}

export const NON_RECIPIENT_KINDS = ['non_hr', 'other'];

export const SENDABLE_CONTACT_KINDS = ['official_hr', 'job_apply', 'general', 'named_recruiter'];

export function isValidEmail(email: string): boolean {
  const e = email.trim();
  const [local, domain = ''] = e.toLowerCase().split('@');
  return /^[a-z0-9][a-z0-9._%+-]*@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(e) && !PLACEHOLDER_LOCAL.test(local) && !PLACEHOLDER_DOMAIN.test(domain);
}

type ScoredContact = { email: string; kind: string; verifiedAt?: Date | null; verifiedBy?: string | null; sourceUrl?: string | null };

/** Öğrenilmiş teslim kestirimi (engine/learned-models.service): adresin mail alma olasılığı ve tüm gönderimlerin temel oranı. */
export interface RecipientDelivery {
  baseRate: number;
  of(contact: ScoredContact): number;
}

export interface RecipientScoring {
  domain?: string | null;
  aliases?: string[];
  preferVerified?: boolean;
  /** Verilmezse (model etkin değilse) puan yalnızca kurallardan oluşur. */
  delivery?: RecipientDelivery;
}

/**
 * Varsayılan alıcı puanı: tür (ilan adresi > İK > işe alım çalışanı > genel) baskındır; aynı türde İK'ya özgü adres,
 * firma alan adıyla eşleşme ve doğrulanmışlık öne geçirir. Teslim modeli etkinse, ulaşma olasılığı temel oranın
 * altında kalan adres geriye, üstünde olan öne kayar; fark büyükse türler arası sıra da değişebilir.
 */
export function recipientScore(c: ScoredContact, opts: RecipientScoring = {}) {
  const local = c.email.split('@')[0].toLowerCase();
  let score = KIND_SCORE[c.kind] ?? 0;
  if (STRONG_HR_LOCAL.test(local)) score += STRONG_HR_BONUS;
  else if (HR_LOCAL.test(local)) score += OTHER_HR_BONUS;
  if (opts.domain && domainMatches(c.email, opts.domain, opts.aliases ?? [])) score += DOMAIN_MATCH_BONUS;
  if (c.verifiedAt) score += opts.preferVerified ? PREFER_VERIFIED_BONUS : VERIFIED_BONUS;
  if (opts.delivery) score += Math.round((opts.delivery.of(c) - opts.delivery.baseRate) * DELIVERY_WEIGHT);
  return score;
}

export function cleanEmail(email: string): string {
  return email.trim().toLowerCase().replace(ESCAPE_PREFIX, '').replace(/\.$/, '');
}

/**
 * Resmî sitede bulunan adresin türünü tahmin eder. Satış/newbusiness adresi İK sayılmaz.
 * İsimden örüntü üretilmez; bu fonksiyon yalnızca yayımlanmış adresleri sınıflar.
 */
export function classifyPublishedEmail(email: string): { kind: ContactKind; note?: string } {
  const [local, domain = ''] = email.toLowerCase().split('@');
  if (KEP_DOMAIN.test(domain)) return { kind: 'non_hr', note: 'KEP (kayıtlı elektronik posta) adresi; normal e-posta kabul etmez' };
  if (NOT_HR_LOCAL.test(local) || NOT_HR_FRAGMENT.test(local)) return { kind: 'non_hr', note: 'Destek/satış/hukuk gibi İK dışı adres — başvuru için kullanılmaz' };
  if (HR_LOCAL.test(local)) return { kind: 'official_hr' };
  if (GENERAL_LOCAL.test(local)) return { kind: 'general' };
  const domainLabel = domain.split('.')[0];
  if (domainLabel && local.replace(/[._-]/g, '') === domainLabel.replace(/-/g, '')) return { kind: 'general' };
  if (PERSON_LOCAL.test(local)) return { kind: 'other', note: 'Kişisel adres olabilir — başvuru için kullanılmaz' };
  return { kind: 'other', note: 'Amacı belirsiz adres — başvuru için kullanılmaz' };
}

export function domainMatches(email: string, companyDomain: string | null | undefined, aliases: string[] = []): boolean {
  const d = normalizeDomain(email.split('@')[1]);
  if (!d) return false;
  const targets = [companyDomain, ...aliases].map((x) => normalizeDomain(x)).filter(Boolean) as string[];
  return targets.some((t) => d === t || d.endsWith(`.${t}`));
}

export function extractEmails(text: string): string[] {
  const found = new Set<string>();
  const re = /(?:mailto:)?([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const e = cleanEmail(m[1]);
    if (!/\.(png|jpg|jpeg|gif|svg|webp)$/.test(e) && !e.includes('example.')) found.add(e);
  }
  return [...found];
}

/** Otomatik gönderim için adresin doğrulanmış sayılıp sayılmadığı. MX/sözdizimi tek başına yeterli değildir. */
export function contactVerifiedForSending(c: { kind: string; verifiedAt: Date | null; suppressed: boolean }): boolean {
  if (c.kind === 'guessed' || c.suppressed) return false;
  return !!c.verifiedAt;
}
