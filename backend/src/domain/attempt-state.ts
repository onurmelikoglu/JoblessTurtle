/**
 * Başvuru gönderim durum makinesi — doküman §13.
 * draft → queued → sending → provider_accepted
 *                         ↘ submission_unknown
 * provider_accepted → replied / bounced / outcome_recorded
 * queued → cancelled / blocked
 * failed_confirmed → controlled_retry (yeni attempt ile)
 */

export type AttemptState =
  | 'queued'
  | 'sending'
  | 'provider_accepted'
  | 'submission_unknown'
  | 'failed_confirmed'
  | 'cancelled'
  | 'blocked'
  | 'replied'
  | 'bounced'
  | 'outcome_recorded';

const TRANSITIONS: Record<AttemptState, AttemptState[]> = {
  queued: ['sending', 'cancelled', 'blocked'],
  sending: ['provider_accepted', 'submission_unknown', 'failed_confirmed'],
  provider_accepted: ['replied', 'bounced', 'outcome_recorded'],
  submission_unknown: ['provider_accepted', 'failed_confirmed', 'outcome_recorded', 'replied', 'bounced'],
  failed_confirmed: [],
  cancelled: [],
  blocked: [],
  replied: ['outcome_recorded', 'replied'],
  bounced: ['outcome_recorded'],
  outcome_recorded: ['outcome_recorded', 'replied'],
};

export function canTransition(from: AttemptState, to: AttemptState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/** Aktif veya başarılı sayılan durumlar — tekrar gönderim engelinde kullanılır. */
export const HOLDS_ACTIVE_KEY: AttemptState[] = [
  'queued',
  'sending',
  'provider_accepted',
  'submission_unknown',
  'replied',
  'bounced',
  'outcome_recorded',
];

export function holdsActiveKey(state: AttemptState) {
  return HOLDS_ACTIVE_KEY.includes(state);
}

export const STATE_LABELS: Record<AttemptState, string> = {
  queued: 'Kuyrukta',
  sending: 'Gönderiliyor',
  provider_accepted: 'Sağlayıcı kabul etti',
  submission_unknown: 'Gönderim belirsiz',
  failed_confirmed: 'Başarısız',
  cancelled: 'İptal edildi',
  blocked: 'Engellendi',
  replied: 'Yanıt geldi',
  bounced: 'Geri döndü (bounce)',
  outcome_recorded: 'Sonuç kaydedildi',
};

export function activeKeyFor(candidateId: string, target: string, intentType: string) {
  return `${candidateId}:${target}:${intentType}`;
}
