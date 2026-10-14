/**
 * Gönderilen başvurulara dönen mailleri (geri dönme bildirimi, otomatik yanıt, firma yanıtı) sınıflandırır.
 * Kurallar deterministiktir; firma yanıtlarında yapay zekâ yalnızca ek ayrıntı (öneri adres, bağlantı, özet) sağlar.
 */

export const INBOUND_CATEGORIES = [
  'bad_address',
  'bad_domain',
  'closed_address',
  'rejected',
  'mailbox_full',
  'too_large',
  'bounce_other',
  'delayed',
  'format_issue',
  'apply_elsewhere',
  'address_changed',
  'auto_reply',
  'out_of_office',
  'human_reply',
  'interview',
  'rejection',
  'do_not_contact',
  'unknown',
] as const;
export type InboundCategory = (typeof INBOUND_CATEGORIES)[number];

export type InboundGroup = 'failed' | 'action' | 'pending' | 'delivered' | 'reply' | 'review';

export const INBOUND_GROUP: Record<InboundCategory, InboundGroup> = {
  bad_address: 'failed',
  bad_domain: 'failed',
  closed_address: 'failed',
  rejected: 'failed',
  mailbox_full: 'failed',
  too_large: 'failed',
  bounce_other: 'failed',
  delayed: 'pending',
  format_issue: 'action',
  apply_elsewhere: 'action',
  address_changed: 'action',
  auto_reply: 'delivered',
  out_of_office: 'delivered',
  human_reply: 'reply',
  interview: 'reply',
  rejection: 'reply',
  do_not_contact: 'reply',
  unknown: 'review',
};

export const INBOUND_LABELS: Record<InboundCategory, string> = {
  bad_address: 'Adres bulunamadı',
  bad_domain: 'Alan adı bulunamadı',
  closed_address: 'Adres dışarıdan mail almıyor',
  rejected: 'Alıcı sunucu reddetti',
  mailbox_full: 'Alıcının kutusu dolu',
  too_large: 'Ekler çok büyük',
  bounce_other: 'İletilemedi',
  delayed: 'Teslim gecikiyor',
  format_issue: 'Kurallara uymadığı için reddedildi',
  apply_elsewhere: 'Başka kanaldan başvuru istendi',
  address_changed: 'Adres değişmiş',
  auto_reply: 'Ulaştı (otomatik yanıt)',
  out_of_office: 'Ulaştı (kişi ofis dışında)',
  human_reply: 'Yanıt geldi',
  interview: 'Görüşme daveti',
  rejection: 'Olumsuz yanıt',
  do_not_contact: 'İletişime geçmeyin talebi',
  unknown: 'İnceleme gerekli',
};

export const INBOUND_HINTS: Partial<Record<InboundCategory, string>> = {
  bad_address: 'Adres yanlış ya da artık kullanılmıyor. Firmanın güncel adresini seçip tekrar gönder.',
  bad_domain: 'Alan adı mail almıyor. Adresi kontrol edip doğru adrese gönder.',
  closed_address: 'Bu adres yalnızca şirket içinden mail kabul ediyor. Firmanın başka bir adresini seç.',
  rejected: 'Alıcı sunucu iletiyi politika veya içerik nedeniyle reddetti. Konuyu, metni veya ekleri sadeleştirip tekrar dene.',
  mailbox_full: 'Alıcının kutusu dolu. Birkaç gün sonra tekrar dene ya da başka adres kullan.',
  too_large: 'Ekler alıcının sınırını aşıyor. Portfolyoyu bağlantı olarak ekleyip tekrar gönder.',
  bounce_other: 'İleti teslim edilemedi. Ayrıntıyı okuyup adresi veya içeriği düzenle.',
  delayed: 'Sunucu teslimi tekrar deniyor; henüz başarısız değil.',
  format_issue: 'Firma belirli bir biçim istiyor. Mail içeriğindeki talimata göre düzenleyip tekrar gönder.',
  apply_elsewhere: 'Firma başvuruları başka bir kanaldan alıyor. Bağlantıdan başvur.',
  address_changed: 'Firma başka bir adres bildirdi. Önerilen adrese tekrar gönder.',
};

/** Başvurunun yerine ulaşmadığı ve kullanıcının müdahalesini bekleyen kategoriler. */
export const UNDELIVERED_CATEGORIES: InboundCategory[] = ['bad_address', 'bad_domain', 'closed_address', 'rejected', 'mailbox_full', 'too_large', 'bounce_other', 'format_issue', 'apply_elsewhere', 'address_changed'];

/** Adresin kendisinin geçersiz olduğu kategoriler: toplu seçimlerde bu adres bir daha kullanılmaz. */
export const DEAD_ADDRESS_CATEGORIES: InboundCategory[] = ['bad_address', 'bad_domain', 'closed_address', 'address_changed'];

export const RESENDABLE_CATEGORIES: InboundCategory[] = [...UNDELIVERED_CATEGORIES, 'unknown'];

export interface InboundMail {
  fromEmail: string | null;
  fromName: string | null;
  subject: string;
  text: string;
  headers: Record<string, string>;
  contentType: string | null;
}

export interface BounceInfo {
  category: InboundCategory;
  status: string | null;
  diagnostic: string | null;
  failedRecipient: string | null;
}

const BOUNCE_SENDER = /^(mailer-?daemon|postmaster|mail-?daemon|mail\.?delivery|bounces?|mdaemon|returned)/i;
const BOUNCE_SENDER_NAME = /(mail delivery (subsystem|system|service)|mailer-daemon|postmaster|microsoft outlook)/i;
const BOUNCE_SUBJECT =
  /(delivery status notification|undeliver(able|ed)|undelivered mail|mail delivery (failed|failure|subsystem)|returned mail|delivery (has )?failed|failure notice|delivery failure|non-?delivery|could not be delivered|message not delivered|teslim edilemedi|iletilemedi|ulaştırılamadı|gönderilemedi|delivery delayed|delayed mail|warning: message)/i;
const DELAY_SUBJECT = /(\(delay\)|delivery delayed|delayed mail|warning: (message|could not)|still being retried|gecik)/i;
const DELAY_TEXT = /(will (retry|continue|keep trying)|has been delayed|is delayed|temporar(y|ily)|deferred|tekrar denenecek|gecikmeli)/i;

const CLOSED_ADDRESS = /(5\.7\.133|5\.7\.134|5\.7\.135|SenderNotAuthenticated|not authenticated for group|only accepts (mail|messages) from|dışarıdan mail kabul etmi|harici gönderen)/i;

/** Durum kodu metinden daha güvenilirdir; önce kod, sonra tanı satırı, en son serbest metin denenir. */
function categoryForStatus(codes: (string | null)[]): InboundCategory | null {
  for (const code of codes) {
    if (!code || !code.startsWith('5')) continue;
    if (/^5\.7\.13[345]$/.test(code)) return 'closed_address';
    if (/^5\.1\.(0|1|6|10)$/.test(code) || code === '5.4.1') return 'bad_address';
    if (/^5\.(1\.2|4\.4)$/.test(code)) return 'bad_domain';
    if (code === '5.2.2') return 'mailbox_full';
    if (/^5\.(3\.4|2\.3)$/.test(code)) return 'too_large';
    if (code.startsWith('5.7.')) return 'rejected';
  }
  return null;
}

/** Karşı sunucunun ayrıntılı yanıtı genel bir red kodundan (Gmail'in 5.7.0'ı gibi) önce gelir. */
function specific(category: InboundCategory | null) {
  return category === 'rejected' ? null : category;
}

function matchRules(text: string | null): InboundCategory | null {
  if (!text) return null;
  if (CLOSED_ADDRESS.test(text)) return 'closed_address';
  for (const [re, category] of RULES) if (re.test(text)) return category;
  return null;
}

const RULES: [RegExp, InboundCategory][] = [
  [/(5\.2\.2|quota|mailbox (is )?full|over ?quota|insufficient (system )?storage|kotas[ıi] dol|kutusu dol)/i, 'mailbox_full'],
  [/(5\.3\.4|5\.2\.3|message (is )?too (big|large)|size limit|exceeds (the )?(maximum )?(message )?size|çok büyük)/i, 'too_large'],
  [/(5\.1\.2|5\.4\.4|domain (name )?(not found|does not exist|couldn'?t be found)|host (or domain name )?not found|no mx|nxdomain|unrouteable domain|domain .{0,60}(couldn'?t|could not) be found|alan ad[ıi] bulunamad)/i, 'bad_domain'],
  [
    /(5\.1\.1|5\.1\.0|5\.1\.6|5\.1\.10|5\.0\.0.{0,40}(unknown|not exist)|user unknown|unknown (user|recipient)|no such (user|recipient|mailbox)|does ?n[o']t exist|address (not found|couldn'?t be found|rejected)|recipient (address )?(rejected|not found|unknown)|invalid (recipient|mailbox|address)|mailbox (unavailable|not found|does not exist)|account (has been |is )?(disabled|deactivated|suspended|inactive)|no longer (in use|valid|available|exists)|not a valid (mailbox|recipient)|is unable to receive mail|adres(i)? bulunamad|alıcı bulunamad|kullanıcı bulunamad|böyle bir (kullanıcı|adres))/i,
    'bad_address',
  ],
  [/(5\.7\.\d+|spam|blocked|blacklist|block ?list|policy|rejected|denied|not (permitted|authorized|allowed)|dmarc|spf|dkim|reputation|engellendi|reddedildi)/i, 'rejected'],
];

function headerValue(headers: Record<string, string>, name: string) {
  return headers[name.toLowerCase()] ?? '';
}

export function isBounce(mail: InboundMail): boolean {
  const local = (mail.fromEmail ?? '').split('@')[0];
  if (BOUNCE_SENDER.test(local)) return true;
  if (/report-type="?delivery-status/i.test(mail.contentType ?? '')) return true;
  if (BOUNCE_SENDER_NAME.test(mail.fromName ?? '') && BOUNCE_SUBJECT.test(mail.subject)) return true;
  return BOUNCE_SUBJECT.test(mail.subject) && /(status:\s*[45]\.\d|diagnostic-code|final-recipient|smtp)/i.test(mail.text);
}

export function analyzeBounce(mail: InboundMail): BounceInfo {
  const text = `${mail.subject}\n${mail.text}`;
  const status = mail.text.match(/Status:\s*([245]\.\d{1,3}\.\d{1,3})/i)?.[1] ?? text.match(/\b([45]\.\d{1,2}\.\d{1,3})\b/)?.[1] ?? null;
  const diagnostic = mail.text.match(/Diagnostic-Code:\s*(?:smtp;\s*)?([^\n]+(?:\n[ \t]+[^\n]+)*)/i)?.[1]?.replace(/\s+/g, ' ').trim().slice(0, 500) ?? null;
  const failedRecipient =
    headerValue(mail.headers, 'x-failed-recipients').split(',')[0]?.trim().toLowerCase() ||
    mail.text.match(/(?:Final|Original)-Recipient:\s*rfc822;\s*<?([^\s>;]+@[^\s>;]+)/i)?.[1]?.toLowerCase() ||
    null;
  const temporary = status?.startsWith('4') || DELAY_SUBJECT.test(mail.subject) || (!status?.startsWith('5') && DELAY_TEXT.test(mail.text));
  if (temporary && !/(5\.\d\.\d|permanent|kalıcı)/i.test(`${status ?? ''} ${diagnostic ?? ''}`)) return { category: 'delayed', status, diagnostic, failedRecipient };
  const remoteCodes = [...(diagnostic ?? '').matchAll(/#?\b([45]\.\d{1,2}\.\d{1,3})\b/g)].map((m) => m[1]);
  const smtpCodes = [...text.matchAll(/\b5\d\d[ -]\(?#?([45]\.\d{1,2}\.\d{1,3})\b/g)].map((m) => m[1]);
  const fromRemote = categoryForStatus(remoteCodes) ?? specific(matchRules(diagnostic));
  const category = fromRemote ?? categoryForStatus([...smtpCodes, status]) ?? matchRules(diagnostic) ?? matchRules(text) ?? 'bounce_other';
  return { category, status, diagnostic, failedRecipient };
}

const AUTO_SUBJECT = /^(\s*(otomatik( yan[ıi]t| cevap)?|automatic reply|auto(matic)?[- ]?(reply|response)|autoreply|out of (the )?office|ofis d[ıi]ş[ıi]nda|izindeyim|abwesenheit|r[ée]ponse automatique)\b|\bauto(matic)? reply\b)/i;
const OUT_OF_OFFICE = /(out of (the )?office|ofis d[ıi]ş[ıi]nda|izindeyim|izinde olaca|y[ıi]ll[ıi]k izin|on (annual )?leave|on vacation|tatildeyim|away from (the )?office|abwesen)/i;
const APPLY_ELSEWHERE = /(kariyer (sitemiz|sayfam[ıi]z|portal)|career(s)? (site|page|portal)|apply (online|through|via)|başvurular[ıi]n[ıi]z[ıi]? .{0,60}(üzerinden|aracılığıyla)|kariyer\.net|linkedin üzerinden|e-?posta (ile|yoluyla) (gelen )?başvuru(lar)?(ı)? (kabul|değerlendir)|do not accept (cv|applications|resumes) (by|via) e-?mail)/i;
const ADDRESS_CHANGED = /(artık kullan[ıi]lmamaktad[ıi]r|kullan[ıi]mdan kald[ıi]r[ıi]lm[ıi]şt[ıi]r|no longer (monitored|in use|active|being monitored)|this (mailbox|address) is (not monitored|unattended)|izlenmemektedir|lütfen .{0,80}@.{0,60} adresine|please (contact|write to|send .{0,30} to) .{0,60}@)/i;
const FORMAT_ISSUE = /(konu (satırına|kısmına|başlığına)|subject (line )?(must|should)|uygun formatta|format(ına|ta) uy|şablon(a|una) uy|belirtilen (formatta|şekilde)|referans (kodu|numarası)|ilan (kodu|numarası)n[ıi]|pdf format[ıi]nda|tek (bir )?dosya)/i;
const SERVICE_NOTICE = /(memnuniyet anketi|anket(imize|e katıl)|değerlendirir misiniz|survey|talebiniz (alınmıştır|oluşturuldu)|destek talebi|ticket|case (number|#)|kayıt numaran[ıi]z)/i;
const DO_NOT_CONTACT = /(iletişime geçmeyin|listeden çıkar|bir daha (mail|e-posta) göndermeyin|do not contact|remove (me|us) from|unsubscribe)/i;
const REJECTION = /(maalesef|olumsuz|uygun bulunmad|değerlendirme(miz)? sonucunda.{0,40}(ilerle|devam).{0,20}(me|ma)|unfortunately|not (be )?moving forward|decided to (pursue|proceed with) other|pozisyon kapanm|position has been filled)/i;
const INTERVIEW = /(görüşme|mülakat|interview|toplant[ıi]|tanışmak isteriz|sizinle (görüşmek|tanışmak)|meet with you|uygun (olduğunuz )?(gün|saat|zaman))/i;

export function isAutomated(mail: InboundMail): boolean {
  const auto = headerValue(mail.headers, 'auto-submitted').toLowerCase();
  if (auto && auto !== 'no') return true;
  if (headerValue(mail.headers, 'x-autoreply') || headerValue(mail.headers, 'x-autorespond') || headerValue(mail.headers, 'x-autogenerated')) return true;
  if (/^(auto_reply|auto-reply)$/i.test(headerValue(mail.headers, 'precedence').trim())) return true;
  if (/^(oof|autoreply)$/i.test(headerValue(mail.headers, 'x-auto-response-suppress').trim())) return true;
  return AUTO_SUBJECT.test(mail.subject);
}

export function classifyCompanyMail(mail: InboundMail): InboundCategory {
  const text = `${mail.subject}\n${mail.text}`;
  const automated = isAutomated(mail);
  if (DO_NOT_CONTACT.test(text)) return 'do_not_contact';
  if (ADDRESS_CHANGED.test(text)) return 'address_changed';
  if (APPLY_ELSEWHERE.test(text) && (automated || /kabul (edil)?me|accept/i.test(text))) return 'apply_elsewhere';
  if (FORMAT_ISSUE.test(text) && (automated || /(reddedil|işleme alınama|değerlendirilemez|could not be processed|rejected)/i.test(text))) return 'format_issue';
  if (automated) return OUT_OF_OFFICE.test(text) ? 'out_of_office' : 'auto_reply';
  if (SERVICE_NOTICE.test(mail.subject)) return 'auto_reply';
  if (REJECTION.test(text)) return 'rejection';
  if (INTERVIEW.test(text)) return 'interview';
  return 'human_reply';
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;

/** Firma yanıtında geçen, gönderen ve alıcı dışındaki ilk adres ve bağlantı. */
export function extractSuggestions(text: string, exclude: string[]): { email: string | null; url: string | null } {
  const skip = new Set(exclude.map((e) => e.toLowerCase()));
  const email = [...text.matchAll(EMAIL_RE)].map((m) => m[0].toLowerCase()).find((e) => !skip.has(e) && !/^(no-?reply|mailer-daemon|postmaster)@/.test(e)) ?? null;
  const url =
    [...text.matchAll(URL_RE)]
      .map((m) => m[0].replace(/[.,;]+$/, ''))
      .find((u) => /(kariyer|career|jobs?|basvuru|apply|isilan|recruit|workday|greenhouse|lever|smartrecruiters|kariyer\.net|linkedin\.com\/jobs)/i.test(u)) ?? null;
  return { email, url };
}

/** Ham iletideki tüm Message-ID değerleri (geri dönme bildirimleri orijinal iletinin başlıklarını içerir). */
export function messageIdsIn(raw: string): string[] {
  return [...new Set([...raw.matchAll(/<[^<>\s@]{4,200}@[^<>\s]{2,200}>/g)].map((m) => m[0].toLowerCase()))];
}

const SECOND_LEVEL = new Set(['com', 'net', 'org', 'gov', 'edu', 'gen', 'bel', 'k12', 'av', 'biz', 'info', 'co', 'ac', 'web', 'tv']);

/** "ik.firma.com.tr" → "firma.com.tr"; alan adına göre eşleştirme için kayıtlı alan adı yaklaşığı. */
export function registrableDomain(emailOrDomain: string): string {
  const host = emailOrDomain.toLowerCase().split('@').pop()!.replace(/\.$/, '');
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const tld = parts[parts.length - 1];
  const sld = parts[parts.length - 2];
  if (tld.length === 2 && SECOND_LEVEL.has(sld)) return parts.slice(-3).join('.');
  return parts.slice(-2).join('.');
}

const FREE_MAIL = new Set(['gmail.com', 'googlemail.com', 'hotmail.com', 'outlook.com', 'live.com', 'yahoo.com', 'icloud.com', 'yandex.com', 'yandex.com.tr', 'protonmail.com', 'proton.me', 'msn.com', 'aol.com', 'mail.com', 'hotmail.com.tr', 'windowslive.com']);

export function isFreeMailDomain(domain: string) {
  return FREE_MAIL.has(domain.toLowerCase());
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

/** Alıntılanmış önceki mesajı (bizim başvurumuz) yanıt metninden ayırır. */
export function stripQuoted(text: string): string {
  const markers = [/^On .{0,200}wrote:\s*$/m, /^.{0,200} tarihinde .{0,200} şunu yazdı:\s*$/m, /^-{2,}\s*Original Message\s*-{2,}/im, /^-{2,}\s*Orijinal (İleti|Mesaj)\s*-{2,}/im, /^From:\s.+\n(Sent|Date|Gönderildi|Tarih):/im, /^Kimden:\s.+/im, /^_{10,}\s*$/m];
  let cut = text.length;
  for (const re of markers) {
    const m = re.exec(text);
    if (m && m.index > 0 && m.index < cut) cut = m.index;
  }
  return text
    .slice(0, cut)
    .split('\n')
    .filter((l) => !/^\s*>/.test(l))
    .join('\n')
    .trim();
}
