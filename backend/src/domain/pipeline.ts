export const PIPELINE_STAGES = ['replied', 'interview', 'offer', 'rejected', 'ghosted', 'withdrawn'] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export const STAGE_LABELS: Record<PipelineStage | 'applied', string> = {
  applied: 'Başvuruldu',
  replied: 'Yanıt geldi',
  interview: 'Mülâkat',
  offer: 'Teklif',
  rejected: 'Olumsuz',
  ghosted: 'Yanıt yok',
  withdrawn: 'Vazgeçtim',
};

/** Aşamanın başvurunun tek "sonuç" alanındaki karşılığı; yanıt aşamasının sonucu yoktur. */
export const OUTCOME_OF_STAGE: Record<PipelineStage, string | null> = {
  replied: null,
  interview: 'interview',
  offer: 'offer',
  rejected: 'rejection',
  ghosted: 'no_response',
  withdrawn: 'other',
};

export const INTERVIEW_KINDS = ['phone', 'video', 'onsite'] as const;
export type InterviewKind = (typeof INTERVIEW_KINDS)[number];
export const INTERVIEW_STATUSES = ['proposed', 'scheduled', 'done', 'cancelled'] as const;
export type InterviewStatus = (typeof INTERVIEW_STATUSES)[number];

export const INTERVIEW_KIND_LABELS: Record<InterviewKind, string> = { phone: 'Telefon', video: 'Görüntülü', onsite: 'Yüz yüze' };

/** Bu kadar gün yanıt gelmeyen ve sonucu girilmemiş başvuru "yanıt yok" olarak önerilir. */
export const GHOST_AFTER_DAYS = 21;
const DAY_MS = 86_400_000;

export function ghostedSuggestion(a: { state: string; outcome: string | null; acceptedAt: Date | null; replyCount: number }, now = Date.now()): boolean {
  if (a.outcome || a.replyCount > 0 || a.state !== 'provider_accepted' || !a.acceptedAt) return false;
  return now - a.acceptedAt.getTime() >= GHOST_AFTER_DAYS * DAY_MS;
}

export const REMINDER_DAY_MS = 24 * 3600_000;
export const REMINDER_HOUR_MS = 3600_000;

/** Planlanmış mülâkat için gönderilmesi gereken hatırlatma: bir gün kala ve bir saat kala, her biri bir kez. */
export function reminderDue(i: { status: string; startsAt: Date; remindedDayAt: Date | null; remindedHourAt: Date | null }, now = Date.now()): 'day' | 'hour' | null {
  if (i.status !== 'scheduled') return null;
  const left = i.startsAt.getTime() - now;
  if (left <= 0) return null;
  if (left <= REMINDER_HOUR_MS && !i.remindedHourAt) return 'hour';
  if (left <= REMINDER_DAY_MS && !i.remindedDayAt && left > REMINDER_HOUR_MS) return 'day';
  return null;
}

const icsDate = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsText = (s: string) => s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');

/** Takvime eklenebilen tek etkinlik (RFC 5545). */
export function interviewIcs(i: { id: string; startsAt: Date; durationMin: number; kind: string; link: string | null; location: string | null; notes: string | null }, company: string, now = new Date()): string {
  const end = new Date(i.startsAt.getTime() + i.durationMin * 60_000);
  const kind = INTERVIEW_KIND_LABELS[i.kind as InterviewKind] ?? 'Mülâkat';
  const description = [i.link, i.notes].filter(Boolean).join('\n');
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Jobless Turtle//Mulakat//TR',
    'BEGIN:VEVENT',
    `UID:${i.id}@jobless-turtle`,
    `DTSTAMP:${icsDate(now)}`,
    `DTSTART:${icsDate(i.startsAt)}`,
    `DTEND:${icsDate(end)}`,
    `SUMMARY:${icsText(`${company} mülâkatı (${kind})`)}`,
    ...(i.location || i.link ? [`LOCATION:${icsText(i.location ?? i.link ?? '')}`] : []),
    ...(description ? [`DESCRIPTION:${icsText(description)}`] : []),
    'BEGIN:VALARM',
    'TRIGGER:-PT1H',
    'ACTION:DISPLAY',
    `DESCRIPTION:${icsText(`${company} mülâkatı`)}`,
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

/** Mailden çıkarılan tarih yalnızca gelecekteyse ve yeterince eminse öneri olur. */
export const INTERVIEW_MIN_CONFIDENCE = 0.6;
export function usableInterviewProposal(p: { startsAt?: string | null; confidence?: number | null }, now = Date.now()): Date | null {
  if (!p.startsAt || (p.confidence ?? 0) < INTERVIEW_MIN_CONFIDENCE) return null;
  const at = new Date(p.startsAt);
  return Number.isNaN(at.getTime()) || at.getTime() <= now ? null : at;
}
