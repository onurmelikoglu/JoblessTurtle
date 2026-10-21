import { CANDIDATE_HR_KIND, classifyPublishedEmail, cleanEmail, isUnverifiableSource } from './contacts';
import { registrableDomain } from './inbound';
import { fold, normalizeCompanyName, normalizeDomain } from './text';

/**
 * Adres araştırmasının saf kuralları: toplayıcı modelin (Sonnet) bulduğu adaylar kaynağında teyit edilir, gerekirse
 * denetçi model (Opus) tarafından değerlendirilir ve burada tür, rol ve 0–100 güven skoruna dönüştürülür. Model ne
 * derse desin tahmini adres düşük güvende kalır, kaynağında görülmeyen adres doğrulanmış sayılmaz.
 */
export const ROLE_TYPES = ['hr', 'recruiting', 'general', 'management', 'employee'] as const;
export type RoleType = (typeof ROLE_TYPES)[number];

/** site: firma sitesi taramasında görüldü · published: model yayımlanmış sayfada buldu · pattern: kalıptan türetildi · stored: daha önce kaydedilmiş, türü belirsiz adres. */
export type CandidateOrigin = 'site' | 'published' | 'pattern' | 'stored';
/** found: sayfa okundu ve adres sayfada geçiyor · missing: sayfa okundu, adres yok · unreadable: sayfa otomatik okunamadı. */
export type SourceCheck = 'found' | 'missing' | 'unreadable';

export interface ResearchCandidate {
  email: string;
  sourceUrl: string | null;
  origin: CandidateOrigin;
  name?: string | null;
  title?: string | null;
  roleType?: string | null;
  evidence?: string | null;
}

export interface CandidateReview {
  keep: boolean;
  roleType?: string | null;
  confidence: number;
  reason?: string | null;
}

export interface SettledContact {
  email: string;
  kind: string;
  roleType: RoleType;
  score: number;
  sourceUrl: string | null;
  name: string | null;
  title: string | null;
  evidence: string | null;
  verified: boolean;
}

/** Elle seçilebilen ama otomatik gönderimde kullanılmayan türler; alıcı listesinde rol adreslerinin arkasında durur. */
export const MANUAL_ONLY_KINDS = ['management', 'employee', 'guessed'];

const KIND_OF_ROLE: Record<RoleType, string> = { hr: 'official_hr', recruiting: 'named_recruiter', general: 'general', management: 'management', employee: 'employee' };
const PERSONAL_ROLES: RoleType[] = ['recruiting', 'management', 'employee'];
const ORIGIN_PRIORITY: Record<CandidateOrigin, number> = { site: 3, published: 2, stored: 1, pattern: 0 };

const BASE_SCORE: Record<SourceCheck, number> = { found: 70, unreadable: 45, missing: 20 };
const OWN_DOMAIN_BONUS = 15;
export const GUESSED_SCORE_CAP = 30;
const MISSING_SOURCE_CAP = 35;
const UNREADABLE_SOURCE_CAP = 60;
const FOREIGN_DOMAIN_CAP = 40;
const UNREVIEWED_PERSONAL_CAP = 40;
const MIN_KEPT_SCORE = 15;
const HIGH_CONFIDENCE = 75;
const MEDIUM_CONFIDENCE = 45;
const MAX_EVIDENCE_CHARS = 300;

const FREE_MAIL_DOMAIN = /^(gmail|googlemail|hotmail|outlook|live|msn|yahoo|ymail|yandex|icloud|me|mac|aol|proton|protonmail|mynet|gmx|mail|windowslive)\.[a-z.]+$/;

export function isFreeMailDomain(email: string) {
  return FREE_MAIL_DOMAIN.test(email.split('@')[1] ?? '');
}

export function isRoleType(value: unknown): value is RoleType {
  return typeof value === 'string' && (ROLE_TYPES as readonly string[]).includes(value);
}

/** Model rol adlarını farklı yazabilir (ik, hr, insan kaynakları…); bilinmeyen değer null olur. */
export function normalizeRoleType(value: string | null | undefined): RoleType | null {
  const v = (value ?? '').toLowerCase().trim();
  if (isRoleType(v)) return v;
  if (/^(ik|insan|human|people|kariyer|career)/.test(v)) return 'hr';
  if (/(recruit|talent|yetenek|işe alım|ise alim|hiring)/.test(v)) return 'recruiting';
  if (/(manage|yönet|yonet|founder|kurucu|ceo|cto|director|direkt|lead)/.test(v)) return 'management';
  if (/(employee|çalışan|calisan|staff|engineer|developer)/.test(v)) return 'employee';
  if (/(general|genel|info|contact|iletişim|iletisim)/.test(v)) return 'general';
  return null;
}

/** Yerel kısmından rolü kesin anlaşılan adres (ik@, kariyer@, info@…); kişisel ya da belirsiz adreste null. */
export function roleOfAddress(email: string): RoleType | null {
  const kind = classifyPublishedEmail(email).kind;
  if (kind === 'official_hr') return 'hr';
  if (kind === 'general') return 'general';
  return null;
}

/** Destek, satış, KVKK, KEP gibi başvuruya hiç uygun olmayan adresler adaydan baştan çıkarılır. */
export function isOffTopicAddress(email: string) {
  return classifyPublishedEmail(email).kind === 'non_hr';
}

const OBFUSCATED_AT = ['@', '&#64;', '&#x40;', '[at]', '(at)', '{at}', ' at ', '[@]', '(@)'];

/** Sayfa metninde adres düz ya da insanın okuyacağı gizlemeyle ("ad [at] firma.com") geçiyor mu. */
export function pageMentionsEmail(page: string, email: string) {
  const text = page.toLowerCase();
  const [local, domain] = cleanEmail(email).split('@');
  if (!local || !domain) return false;
  if (text.includes(`${local}@${domain}`)) return true;
  const domainForms = [domain, domain.replace(/\./g, ' . '), domain.replace(/\./g, ' dot '), domain.replace(/\./g, ' [dot] '), domain.replace(/\./g, '(dot)')];
  const compact = text.replace(/\s+/g, ' ');
  return OBFUSCATED_AT.some((at) => domainForms.some((d) => compact.includes(`${local}${at}${d}`) || compact.includes(`${local} ${at.trim()} ${d}`)));
}

/** Aynı adresin birden çok kaynaktan gelen kayıtları birleştirilir; en güçlü köken ve dolu alanlar korunur. */
export function mergeCandidates(candidates: ResearchCandidate[]): ResearchCandidate[] {
  const byEmail = new Map<string, ResearchCandidate>();
  for (const raw of candidates) {
    const c = { ...raw, email: cleanEmail(raw.email) };
    const prev = byEmail.get(c.email);
    if (!prev) {
      byEmail.set(c.email, c);
      continue;
    }
    const strong = ORIGIN_PRIORITY[c.origin] > ORIGIN_PRIORITY[prev.origin] ? c : prev;
    const weak = strong === c ? prev : c;
    byEmail.set(c.email, {
      ...strong,
      name: strong.name ?? weak.name,
      title: strong.title ?? weak.title,
      roleType: strong.roleType ?? weak.roleType,
      evidence: strong.evidence ?? weak.evidence,
      sourceUrl: strong.sourceUrl ?? weak.sourceUrl,
    });
  }
  return [...byEmail.values()];
}

/** Okunabilir sayfada görülen, firma alan adındaki rol adresi kendiliğinden kesindir; diğerleri denetçiye gider. */
export function needsReview(c: ResearchCandidate, check: SourceCheck, domainMatch: boolean) {
  return !(c.origin !== 'pattern' && check === 'found' && domainMatch && roleOfAddress(c.email) !== null);
}

export function sourceIsReadable(sourceUrl: string | null | undefined) {
  return !!sourceUrl && /^https?:\/\//i.test(sourceUrl) && !isUnverifiableSource(sourceUrl) && !/\.pdf($|[?#])/i.test(sourceUrl);
}

export function confidenceLabel(score: number) {
  if (score >= HIGH_CONFIDENCE) return 'high';
  return score >= MEDIUM_CONFIDENCE ? 'medium' : 'low';
}

function clampScore(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export interface SettleContext {
  check: SourceCheck;
  domainMatch: boolean;
  /** Denetçi bu adayı değerlendirdi mi; değerlendirildiyse review yoksa aday düşer. */
  reviewed: boolean;
  review?: CandidateReview | null;
}

/**
 * Adayı kaydedilecek adrese dönüştürür ya da eler. Rolü yerel kısmından belli adreste (ik@, info@) o rol esastır;
 * kişisel adreste modelin rolü kullanılır. Skor tavanları: tahmini 30, kaynağında görülmeyen 35, okunamayan kaynak 60,
 * firma alan adı dışı 40, denetlenmemiş kişisel adres 40.
 */
export function settleCandidate(c: ResearchCandidate, ctx: SettleContext): SettledContact | null {
  const email = cleanEmail(c.email);
  if (isOffTopicAddress(email)) return null;
  if (ctx.reviewed && ctx.review && !ctx.review.keep) return null;
  const reviewed = ctx.reviewed && !!ctx.review;
  const addressRole = roleOfAddress(email);
  const claimedRole = normalizeRoleType(ctx.review?.roleType) ?? normalizeRoleType(c.roleType);
  const roleType: RoleType | null = addressRole ?? (claimedRole === 'hr' ? 'recruiting' : claimedRole);
  if (!roleType) return null;
  const personal = PERSONAL_ROLES.includes(roleType);
  if (personal && isFreeMailDomain(email)) return null;
  if (!reviewed && ctx.check === 'missing') return null;

  let score = reviewed ? clampScore(ctx.review!.confidence) : BASE_SCORE[ctx.check] + (ctx.domainMatch ? OWN_DOMAIN_BONUS : 0);
  if (ctx.check === 'missing') score = Math.min(score, MISSING_SOURCE_CAP);
  if (ctx.check === 'unreadable') score = Math.min(score, UNREADABLE_SOURCE_CAP);
  if (!ctx.domainMatch) score = Math.min(score, FOREIGN_DOMAIN_CAP);
  if (personal && !reviewed) score = Math.min(score, UNREVIEWED_PERSONAL_CAP);
  const guessed = c.origin === 'pattern';
  if (guessed) score = Math.min(score, GUESSED_SCORE_CAP);
  if (score < MIN_KEPT_SCORE) return null;

  let kind = guessed ? 'guessed' : KIND_OF_ROLE[roleType];
  if (!guessed && !ctx.domainMatch && !personal && isUnverifiableSource(c.sourceUrl)) kind = CANDIDATE_HR_KIND;
  return {
    email,
    kind,
    roleType,
    score,
    sourceUrl: c.sourceUrl,
    name: c.name?.trim() || null,
    title: c.title?.trim() || null,
    evidence: (ctx.review?.reason ? `${c.evidence ?? ''} — ${ctx.review.reason}` : (c.evidence ?? '')).replace(/^ — /, '').slice(0, MAX_EVIDENCE_CHARS) || null,
    verified: kind === 'official_hr' && ctx.domainMatch && ctx.check !== 'missing',
  };
}

/** Kayıtlı türün yerini alma sırası: daha güçlü bir türe yükseltilir, asla düşürülmez. */
const KIND_RANK: Record<string, number> = { job_apply: 8, official_hr: 7, named_recruiter: 6, general: 5, management: 4, employee: 3, group_hr: 2, candidate_hr: 2, guessed: 1, other: 0, non_hr: 0 };

export function upgradesKind(current: string, next: string) {
  return (KIND_RANK[next] ?? 0) > (KIND_RANK[current] ?? 0);
}

/** Posta sunucusu yoklamasının sonucu (engine/mail/smtp-probe ile aynı değerler). */
export type ProbeVerdict = 'exists' | 'missing' | 'unknown';

/** Yayımlanmış adres bulunamayınca firmanın alan adında denenen yaygın başvuru adresleri, öncelik sırasıyla. */
export const ROLE_GUESS_LOCALS = ['kariyer', 'ik', 'hr', 'careers', 'insankaynaklari', 'info', 'bilgi', 'iletisim'];
/** Posta sunucusu hiçbir şeyi doğrulayamadığında yine de listelenen en olası iki adres. */
const FALLBACK_GUESS_LOCALS = ['kariyer', 'info'];
const MAX_CONFIRMED_GUESSES = 3;
const CONFIRMED_GUESS_SCORE = 55;
const GENERIC_GUESS_SCORE = 20;

export function roleGuessesFor(domain: string) {
  return ROLE_GUESS_LOCALS.map((local) => `${local}@${domain}`);
}

/** Alan adında yaygın adres; tür "tahmini", rol yerel kısmından gelir. Yoklamada kutusu doğrulanırsa türü yükselir. */
export function genericGuess(email: string): SettledContact {
  return { email, kind: 'guessed', roleType: roleOfAddress(email) ?? 'general', score: GENERIC_GUESS_SCORE, sourceUrl: null, name: null, title: null, evidence: 'Firmanın alan adında yaygın başvuru adresi', verified: false };
}

function withNote(evidence: string | null, note: string) {
  return [evidence, note].filter(Boolean).join(' — ').slice(0, MAX_EVIDENCE_CHARS);
}

/**
 * Tahmini adresi posta sunucusunun cevabına göre günceller: olmayan kutu düşer; var olduğu doğrulanan kutu rolünün
 * türüne yükselir (yine de kaynağında görülmediği için doğrulanmış sayılmaz); anlaşılamayan tahmin olduğu gibi kalır.
 */
export function settleProbedGuess(c: SettledContact, verdict: ProbeVerdict, catchAll: boolean | null): SettledContact | null {
  if (verdict === 'missing') return null;
  if (verdict === 'exists') return { ...c, kind: KIND_OF_ROLE[c.roleType], score: Math.max(c.score, CONFIRMED_GUESS_SCORE), verified: false, evidence: withNote(c.evidence, 'Yayımlanmamış; posta sunucusu bu kutunun var olduğunu doğruladı') };
  return { ...c, evidence: withNote(c.evidence, catchAll ? 'Alan adı her adresi kabul ediyor; kutunun varlığı doğrulanamadı' : 'Posta sunucusu yoklamaya cevap vermedi; kutunun varlığı bilinmiyor') };
}

/**
 * Yoklanmış yaygın adreslerden hangilerinin kaydedileceği: kutusu doğrulananlar (en fazla 3). Hiçbir adres
 * doğrulanamadıysa en olası iki adres (kariyer@, info@) tahmini olarak listelenir ki kullanıcı elle deneyebilsin.
 */
export function pickGenericGuesses(probed: SettledContact[], confirmedElsewhere = false): SettledContact[] {
  const confirmed = probed.filter((c) => c.kind !== 'guessed');
  if (confirmed.length || confirmedElsewhere) return confirmed.slice(0, MAX_CONFIRMED_GUESSES);
  return probed.filter((c) => FALLBACK_GUESS_LOCALS.includes(c.email.split('@')[0]));
}

const NOT_COMPANY_SITE = /(?:^|\.)(linkedin|kariyer|eleman|yenibiris|secretcv|youthall|anbean|toptalent|techcareer|glassdoor|indeed|facebook|instagram|twitter|x|youtube|google|wikipedia|github|medium|bulurum|firmasec|yandex|sirketler|firmarehberi|kompass|zoominfo|crunchbase|bloomberg|eksisozluk|sikayetvar)\.(com|net|org|co|io|ru|com\.tr|net\.tr|org\.tr)$/;
const GENERIC_NAME_WORDS = new Set(['gida', 'ilac', 'tekstil', 'teknoloji', 'yazilim', 'bilisim', 'holding', 'grup', 'group', 'turkiye', 'turkey', 'istanbul', 'ankara', 'izmir', 'danismanlik', 'iletisim', 'magazacilik', 'discount', 'sanayi', 'insaat', 'enerji', 'agency', 'ajans', 'digital', 'dijital', 'studio', 'media', 'medya', 'games', 'oyun', 'ticaret', 'pazarlama', 'reklam', 'lojistik', 'the', 've', 'and']);
const MIN_NAME_TOKEN = 3;

/** Model firmanın sitesi diye ilan sitesi, sosyal medya ya da rehber sayfası verebilir; bunlar firma alan adı sayılmaz. */
export function isCompanySiteDomain(domain: string | null | undefined) {
  return !!domain && !NOT_COMPANY_SITE.test(domain) && !domain.endsWith('kep.tr');
}

/** Alan adı firmanın adını taşıyor mu ("Yıldızlı Gıda" → yildizlimarket.com, "BELDİ" → beldi.com.tr). */
export function domainCarriesName(companyName: string, domain: string) {
  const label = fold(registrableDomain(domain).split('.')[0]).replace(/[^a-z0-9]/g, '');
  const tokens = normalizeCompanyName(companyName)
    .split(' ')
    .filter((t) => t.length >= MIN_NAME_TOKEN && !GENERIC_NAME_WORDS.has(t));
  return !!label && tokens.some((t) => label.includes(t));
}

/**
 * Alan adı bilinmeyen firmada modelin bildirdiği site benimsenir mi: firma sitesi olabilecek bir alan adı olmalı ve
 * ya firmanın adını taşımalı ya da modelin bulduğu adres/ofis kaynaklarından biri o alan adında olmalı.
 */
export function websiteDomainFor(companyName: string, website: string | null | undefined, sourceUrls: (string | null | undefined)[]): string | null {
  const host = normalizeDomain(website);
  if (!host || !isCompanySiteDomain(host)) return null;
  const domain = registrableDomain(host);
  const sourced = sourceUrls.some((u) => {
    const d = normalizeDomain(u);
    return !!d && (d === domain || d.endsWith(`.${domain}`));
  });
  return sourced || domainCarriesName(companyName, domain) ? domain : null;
}

