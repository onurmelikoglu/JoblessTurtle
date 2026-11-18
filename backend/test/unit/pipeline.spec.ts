import { ghostedSuggestion, interviewIcs, reminderDue, usableInterviewProposal } from '../../src/domain/pipeline';

const NOW = new Date('2026-11-09T10:00:00Z').getTime();
const days = (n: number) => new Date(NOW - n * 86_400_000);

describe('başvuru süreci', () => {
  it('21 gün yanıtsız ve sonucu girilmemiş başvuru "yanıt yok" önerilir', () => {
    expect(ghostedSuggestion({ state: 'provider_accepted', outcome: null, acceptedAt: days(22), replyCount: 0 }, NOW)).toBe(true);
    expect(ghostedSuggestion({ state: 'provider_accepted', outcome: null, acceptedAt: days(10), replyCount: 0 }, NOW)).toBe(false);
    expect(ghostedSuggestion({ state: 'replied', outcome: null, acceptedAt: days(30), replyCount: 1 }, NOW)).toBe(false);
    expect(ghostedSuggestion({ state: 'provider_accepted', outcome: 'interview', acceptedAt: days(30), replyCount: 0 }, NOW)).toBe(false);
  });

  it('hatırlatma bir gün ve bir saat kala, birer kez', () => {
    const base = { status: 'scheduled', remindedDayAt: null, remindedHourAt: null };
    expect(reminderDue({ ...base, startsAt: new Date(NOW + 20 * 3600_000) }, NOW)).toBe('day');
    expect(reminderDue({ ...base, startsAt: new Date(NOW + 30 * 3600_000) }, NOW)).toBeNull();
    expect(reminderDue({ ...base, startsAt: new Date(NOW + 30 * 60_000) }, NOW)).toBe('hour');
    expect(reminderDue({ ...base, remindedHourAt: new Date(NOW), startsAt: new Date(NOW + 30 * 60_000) }, NOW)).toBeNull();
    expect(reminderDue({ ...base, status: 'proposed', startsAt: new Date(NOW + 30 * 60_000) }, NOW)).toBeNull();
    expect(reminderDue({ ...base, startsAt: new Date(NOW - 60_000) }, NOW)).toBeNull();
  });

  it('takvim dosyası etkinliği ve hatırlatmayı içerir', () => {
    const ics = interviewIcs({ id: 'i1', startsAt: new Date('2026-11-12T11:00:00Z'), durationMin: 45, kind: 'video', link: 'https://meet.example/abc', location: null, notes: 'Teknik görüşme; kamera açık' }, 'Örnek A.Ş.', new Date(NOW));
    expect(ics).toContain('DTSTART:20261112T110000Z');
    expect(ics).toContain('DTEND:20261112T114500Z');
    expect(ics).toContain('SUMMARY:Örnek A.Ş. mülâkatı (Görüntülü)');
    expect(ics).toContain('DESCRIPTION:https://meet.example/abc\\nTeknik görüşme\\; kamera açık');
    expect(ics).toContain('TRIGGER:-PT1H');
  });

  it('mailden çıkan tarih gelecekteyse ve güven yeterliyse kullanılır', () => {
    expect(usableInterviewProposal({ startsAt: '2026-11-12T11:00:00Z', confidence: 0.8 }, NOW)?.toISOString()).toBe('2026-11-12T11:00:00.000Z');
    expect(usableInterviewProposal({ startsAt: '2026-11-01T11:00:00Z', confidence: 0.9 }, NOW)).toBeNull();
    expect(usableInterviewProposal({ startsAt: '2026-11-12T11:00:00Z', confidence: 0.3 }, NOW)).toBeNull();
    expect(usableInterviewProposal({ startsAt: 'yarın', confidence: 0.9 }, NOW)).toBeNull();
  });
});
