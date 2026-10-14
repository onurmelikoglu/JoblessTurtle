import { classifyPublishedEmail, domainMatches, isUnverifiableSource, PERSON_LOCAL, STRONG_HR_LOCAL } from './contacts';
import type { InboundCategory } from './inbound';
import { normalizeDomain } from './text';

/**
 * Adres sicili: bir e-posta adresinin nereden bulunduğu ve gönderimlerde ne sonuç verdiği. Kayıt çalışma alanları
 * üstüdür; bir kullanıcının öğrendiği "bu adres çalışıyor / çalışmıyor" bilgisi herkes için geçerlidir.
 */
export const ADDRESS_STATUSES = ['unknown', 'deliverable', 'dead'] as const;
export type AddressStatus = (typeof ADDRESS_STATUSES)[number];

export const ADDRESS_SOURCE_TYPES = ['company_site', 'careers_page', 'job_board', 'social', 'directory', 'other_site', 'reply', 'user', 'unknown'] as const;
export type AddressSourceType = (typeof ADDRESS_SOURCE_TYPES)[number];

/** Yanıt gelmese de geri dönmeyen mailin ulaştığı kabul edilmeden önce beklenen süre. */
export const NO_BOUNCE_SETTLE_HOURS = 72;
/** Gelen kutusu izlenemeyen hesaplarda sonucu öğrenilemeyen gönderim bu sürenin sonunda "gözlenemedi" diye kapatılır. */
export const UNOBSERVED_AFTER_DAYS = 14;

const JOB_BOARD_HOST = /(?:^|\.)(kariyer\.net|eleman\.net|secretcv\.com|yenibiris\.com|isbul\.net|isinolsun\.com|indeed\.com|glassdoor\.com|glassdoor\.com\.tr|jooble\.org|careerjet\.com\.tr|greenhouse\.io|lever\.co|workable\.com|teamtailor\.com|smartrecruiters\.com|recruitee\.com|breezy\.hr|peoplise\.com|youthall\.com|toptalent\.co|anbean\.co)$/i;
const SOCIAL_HOST = /(?:^|\.)(linkedin\.com|facebook\.com|instagram\.com|twitter\.com|x\.com|youtube\.com|medium\.com|t\.me)$/i;
const CAREERS_HINT = /(kariyer|career|careers|jobs|join|ik\b|insan-?kaynaklari|human-?resources|work-?with-?us|bize-?katil|acik-?pozisyon)/i;

export function addressSourceType(sourceUrl: string | null | undefined, companyDomain?: string | null, aliases: string[] = []): AddressSourceType {
  if (!sourceUrl) return 'unknown';
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    return 'unknown';
  }
  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  if (SOCIAL_HOST.test(host)) return 'social';
  if (JOB_BOARD_HOST.test(host)) return 'job_board';
  const own = [companyDomain, ...aliases].map((d) => normalizeDomain(d)).filter((d): d is string => !!d);
  if (own.some((d) => host === d || host.endsWith(`.${d}`))) return CAREERS_HINT.test(`${host}${url.pathname}`) ? 'careers_page' : 'company_site';
  if (isUnverifiableSource(sourceUrl)) return 'directory';
  return CAREERS_HINT.test(host) ? 'careers_page' : 'other_site';
}

export interface DeliveryEffect {
  delivered: boolean;
  bounced: boolean;
  replied: boolean;
  /** Kalıcı geçersizlik: yalnızca sunucunun kesin bildirdiği durumlar (yapay zekâ yorumu değil). */
  dead: 'address' | 'domain' | null;
}

const EFFECTS: Partial<Record<InboundCategory, DeliveryEffect>> = {
  bad_address: { delivered: false, bounced: true, replied: false, dead: 'address' },
  closed_address: { delivered: false, bounced: true, replied: false, dead: 'address' },
  bad_domain: { delivered: false, bounced: true, replied: false, dead: 'domain' },
  rejected: { delivered: false, bounced: true, replied: false, dead: null },
  mailbox_full: { delivered: false, bounced: true, replied: false, dead: null },
  too_large: { delivered: false, bounced: true, replied: false, dead: null },
  bounce_other: { delivered: false, bounced: true, replied: false, dead: null },
  address_changed: { delivered: false, bounced: true, replied: false, dead: null },
  format_issue: { delivered: true, bounced: false, replied: false, dead: null },
  apply_elsewhere: { delivered: true, bounced: false, replied: false, dead: null },
  auto_reply: { delivered: true, bounced: false, replied: false, dead: null },
  out_of_office: { delivered: true, bounced: false, replied: false, dead: null },
  human_reply: { delivered: true, bounced: false, replied: true, dead: null },
  interview: { delivered: true, bounced: false, replied: true, dead: null },
  rejection: { delivered: true, bounced: false, replied: true, dead: null },
  do_not_contact: { delivered: true, bounced: false, replied: true, dead: null },
};

/** Elle ya da webhook ile girilen eski tip yanıt sınıfının mail dönüşü kategorisindeki karşılığı. */
export const LEGACY_CLASSIFICATION_CATEGORY: Record<string, InboundCategory> = {
  bounce: 'bounce_other',
  autoresponder: 'auto_reply',
  human_reply: 'human_reply',
  interview: 'interview',
  rejection: 'rejection',
  do_not_contact: 'do_not_contact',
};

/** Mail dönüşünün adres siciline etkisi; bilgi taşımayan kategoriler (gecikme, belirsiz) null döner. */
export function deliveryEffectOf(category: string | null | undefined): DeliveryEffect | null {
  return (category && EFFECTS[category as InboundCategory]) || null;
}

/** Birden fazla dönüş varsa kesin olan öne geçer: kalıcı geçersizlik > yanıt > teslim > geri dönme. */
export function strongestEffect(categories: (string | null | undefined)[]): { category: string; effect: DeliveryEffect } | null {
  const ranked = categories
    .map((category) => ({ category: category ?? '', effect: deliveryEffectOf(category) }))
    .filter((x): x is { category: string; effect: DeliveryEffect } => !!x.effect)
    .sort((a, b) => rank(b.effect) - rank(a.effect));
  return ranked[0] ?? null;
}

function rank(e: DeliveryEffect) {
  if (e.dead) return 4;
  if (e.replied) return 3;
  if (e.delivered) return 2;
  return 1;
}

/** Öğrenme özelliği: adresin yerel kısmının türü (İK'ya özgü, genel, kişi adı…). */
export function localPartClass(email: string): 'strong_hr' | 'hr' | 'general' | 'person' | 'non_hr' | 'other' {
  const local = email.split('@')[0].toLowerCase();
  if (STRONG_HR_LOCAL.test(local)) return 'strong_hr';
  const cls = classifyPublishedEmail(email.toLowerCase());
  if (cls.kind === 'official_hr') return 'hr';
  if (cls.kind === 'general') return 'general';
  if (cls.kind === 'non_hr') return 'non_hr';
  return PERSON_LOCAL.test(local) ? 'person' : 'other';
}

export interface AddressFeatures {
  kind: string;
  local: ReturnType<typeof localPartClass>;
  domainMatch: boolean;
  sourceType: AddressSourceType;
  verified: boolean;
}

export function addressFeatures(a: { email: string; kind: string; sourceUrl?: string | null; verified?: boolean }, company: { canonicalDomain: string | null; aliases?: string[] }): AddressFeatures {
  return {
    kind: a.kind,
    local: localPartClass(a.email),
    domainMatch: domainMatches(a.email, company.canonicalDomain, company.aliases ?? []),
    sourceType: addressSourceType(a.sourceUrl, company.canonicalDomain, company.aliases ?? []),
    verified: !!a.verified,
  };
}

export function emailDomain(email: string): string | null {
  return normalizeDomain(email.split('@')[1]);
}
