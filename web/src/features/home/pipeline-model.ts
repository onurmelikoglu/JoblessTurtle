import type { InterviewItem } from '@/api/types';
import type { PipelineStageName } from '@/api/home';

export const STAGE_OPTIONS: { value: PipelineStageName; label: string }[] = [
  { value: 'replied', label: 'Yanıt geldi' },
  { value: 'interview', label: 'Mülâkat' },
  { value: 'offer', label: 'Teklif' },
  { value: 'rejected', label: 'Olumsuz' },
  { value: 'ghosted', label: 'Yanıt yok' },
  { value: 'withdrawn', label: 'Vazgeçtim' },
];

export const INTERVIEW_KIND_TEXT: Record<InterviewItem['kind'], string> = { phone: 'Telefon', video: 'Görüntülü', onsite: 'Yüz yüze' };
export const INTERVIEW_STATUS_TEXT: Record<InterviewItem['status'], string> = { proposed: 'Onay bekliyor', scheduled: 'Planlandı', done: 'Yapıldı', cancelled: 'İptal' };

/** datetime-local alanının değeri (yerel saat) ISO tarihine çevrilir; boş ya da geçersizse null. */
export function localInputToIso(value: string): string | null {
  if (!value) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

export const interviewFileName = (i: Pick<InterviewItem, 'company' | 'startsAt'>) => `mulakat-${i.company.toLocaleLowerCase('tr').replace(/[^a-z0-9ğüşıöç]+/g, '-')}-${i.startsAt.slice(0, 10)}.ics`;
