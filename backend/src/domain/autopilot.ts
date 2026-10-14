import { INBOUND_GROUP, type InboundCategory } from './inbound';

/**
 * Otopilot: gönderilen başvuruya dönen mailin kategorisine göre bir sonraki adımı kurallarla seçer. Yapay zekâ yalnızca
 * kuralın yetmediği yerde (yazının firmanın istediği biçime getirilmesi, nedeni belirsiz dönüşün yorumlanması, yeni
 * adres araması) devreye girer.
 */
export const AUTOPILOT_STEPS = ['resend', 'fix_format', 'research', 'ai_review', 'use_link', 'stop'] as const;
export type AutopilotStep = (typeof AUTOPILOT_STEPS)[number];

/**
 * proposed: kullanıcının onayını bekliyor · running: uygulanıyor · executed: yeniden gönderim sıraya alındı ·
 * info: gönderilecek bir şey yok, kullanıcıya ne yapılacağı söylendi · failed: uygulanamadı · dismissed: kullanıcı vazgeçti.
 */
export const AUTOPILOT_STATES = ['proposed', 'running', 'executed', 'info', 'failed', 'dismissed'] as const;
export type AutopilotState = (typeof AUTOPILOT_STATES)[number];

export const AUTOPILOT_MODES = ['auto', 'approval', 'stopped'] as const;
/** auto: "Otomatik başvur" açık, düzeltmeler kendiliğinden gider · approval: onay bekler · stopped: acil durdurma açık. */
export type AutopilotMode = (typeof AUTOPILOT_MODES)[number];

/** Bir başvuru için kullanıcıya sorulmadan yapılabilecek en fazla düzeltme. */
export const MAX_AUTO_FIXES = 2;
export const MAILBOX_FULL_RETRY_DAYS = 3;
/** Bundan eski dönüşler için öneri üretilmez; başvurunun bağlamı eskimiştir. */
export const AUTOPILOT_LOOKBACK_DAYS = 45;

export type StopCode = 'max_fixes' | 'no_address' | 'attachment_limit' | 'mailbox_full';

export type FixDecision =
  | { step: 'resend'; toEmail: string; attachments: 'all' | 'cv_only'; delayDays: number; why: string }
  | { step: 'fix_format'; why: string }
  | { step: 'research'; why: string }
  | { step: 'ai_review'; why: string }
  | { step: 'use_link'; why: string }
  | { step: 'stop'; code: StopCode; why: string }
  | { step: 'none' };

export interface FixContext {
  category: InboundCategory;
  sentTo: string | null;
  /** Firmanın yanıtında bildirdiği ve geçersiz olduğu bilinmeyen adres. */
  suggestedEmail: string | null;
  /** Firmanın gönderilebilir diğer adresleri, tercih sırasıyla; gönderilen adres ve geçersiz adresler hariç. */
  alternatives: string[];
  attachments: { cv: number; other: number };
  /** Bu başvuru zincirinde kullanıcıya sorulmadan yapılmış düzeltme sayısı. */
  autoFixes: number;
  /** Aynı adrese bu zincirde daha önce yeniden gönderildi mi (kutu dolu denemesi). */
  retriedSameAddress: boolean;
  /** Bu dönüşten sonra yeni adres araması yapılabilir mi. */
  canResearch: boolean;
}

/** Sunucunun neden reddettiği ya da mailin ne dediği kuralla anlaşılamayan dönüşler: yapay zekâ okur, kullanıcı onaylar. */
const NEEDS_READING: InboundCategory[] = ['rejected', 'bounce_other', 'unknown'];
const ADDRESS_GONE: InboundCategory[] = ['bad_address', 'bad_domain', 'closed_address'];

export function decideFix(c: FixContext): FixDecision {
  const group = INBOUND_GROUP[c.category];
  if (group === 'reply' || group === 'delivered' || group === 'pending') return { step: 'none' };
  if (c.category === 'apply_elsewhere') return { step: 'use_link', why: 'Firma başvuruları mail ile almıyor; mail denemesi durduruldu. Firmanın gösterdiği sayfadan başvurabilirsin.' };
  if (NEEDS_READING.includes(c.category)) return { step: 'ai_review', why: 'Dönüşün nedeni kesin değil; yapay zekâ maili okuyup düzeltilebilir mi diye bakacak.' };
  if (c.autoFixes >= MAX_AUTO_FIXES) return { step: 'stop', code: 'max_fixes', why: `Bu başvuru ${MAX_AUTO_FIXES} kez otomatik düzeltildi ve yine dönüş aldı; bundan sonrası için senin kararın gerekiyor.` };

  if (c.category === 'too_large') {
    if (c.sentTo && c.attachments.cv > 0 && c.attachments.other > 0) return { step: 'resend', toEmail: c.sentTo, attachments: 'cv_only', delayDays: 0, why: 'Ekler alıcının boyut sınırını aştı; yalnızca CV ile yeniden gönderilecek.' };
    return { step: 'stop', code: 'attachment_limit', why: 'Mail yalnızca CV ile de alıcının boyut sınırını aşıyor; daha küçük bir CV dosyası yüklemen gerekiyor.' };
  }
  if (c.category === 'mailbox_full') {
    if (c.sentTo && !c.retriedSameAddress) return { step: 'resend', toEmail: c.sentTo, attachments: 'all', delayDays: MAILBOX_FULL_RETRY_DAYS, why: `Alıcının kutusu dolu; ${MAILBOX_FULL_RETRY_DAYS} gün sonra aynı adrese yeniden denenecek.` };
    if (c.alternatives.length) return { step: 'resend', toEmail: c.alternatives[0], attachments: 'all', delayDays: 0, why: 'Alıcının kutusu hâlâ dolu; firmanın bilinen diğer adresine gönderilecek.' };
    return { step: 'stop', code: 'mailbox_full', why: 'Alıcının kutusu hâlâ dolu ve firmanın bilinen başka adresi yok.' };
  }
  if (c.category === 'format_issue') return { step: 'fix_format', why: 'Firma belirli bir biçim istiyor; yazı firmanın talimatına göre düzenlenip yeniden gönderilecek.' };
  if (c.category === 'address_changed' && c.suggestedEmail) return { step: 'resend', toEmail: c.suggestedEmail, attachments: 'all', delayDays: 0, why: 'Firma başvurular için başka bir adres bildirdi; aynı yazı o adrese gönderilecek.' };
  if (ADDRESS_GONE.includes(c.category) || c.category === 'address_changed') {
    if (c.alternatives.length) return { step: 'resend', toEmail: c.alternatives[0], attachments: 'all', delayDays: 0, why: 'Adres geçersiz çıktı; firmanın bilinen sıradaki adresine gönderilecek.' };
    if (c.canResearch) return { step: 'research', why: 'Adres geçersiz çıktı ve firmanın bilinen başka adresi yok; geçersiz adresler dışında yeni adres aranacak.' };
    return { step: 'stop', code: 'no_address', why: 'Adres geçersiz çıktı; yapılan aramada firmanın kullanılabilir başka bir adresi bulunamadı. Firmanın diğer başvuru kanallarını kullanabilirsin.' };
  }
  return { step: 'none' };
}

/** Uygulanırken yapay zekâ çağrısı gerektiren adımlar; öneri onaylanmadan çağrı yapılmaz. */
export function needsAi(step: AutopilotStep): boolean {
  return step === 'fix_format' || step === 'research' || step === 'ai_review';
}
