import { funnel, MIN_REPLIES_FOR_SUGGESTION, ratesBy, sendTimeGrid, StatAttempt, suggestSendTime, weekly, weekOf } from '../../src/domain/stats';

const base: StatAttempt = { sentAt: new Date('2026-11-09T07:30:00Z'), failed: false, replied: false, interview: false, offer: false, sector: 'yazılım', size: '51-200', channel: 'email', language: 'tr', intent: 'job', source: 'discovery' };
const at = (patch: Partial<StatAttempt>) => ({ ...base, ...patch });

describe('istatistikler', () => {
  it('huni gönderimden teklife daralır', () => {
    const list = [at({}), at({ failed: true }), at({ replied: true }), at({ replied: true, interview: true }), at({ replied: true, interview: true, offer: true })];
    expect(funnel(list).map((s) => s.count)).toEqual([5, 4, 3, 2, 1]);
  });

  it('yanıt oranı boyuta göre; az örnekli satırlar Diğer olur', () => {
    const list = [at({ sector: 'yazılım', replied: true }), at({ sector: 'yazılım' }), at({ sector: 'yazılım' }), at({ sector: 'oyun', replied: true }), at({ sector: null })];
    expect(ratesBy(list, (a) => a.sector)).toEqual([
      { key: 'yazılım', label: 'yazılım', sent: 3, replied: 1, rate: 0.333 },
      { key: 'other', label: 'Diğer / bilinmiyor', sent: 2, replied: 1, rate: 0.5 },
    ]);
  });

  it('hafta pazartesiden başlar ve Türkiye saatine göre hesaplanır', () => {
    expect(weekOf(new Date('2026-11-15T22:30:00Z'))).toBe('2026-11-16');
    expect(weekOf(new Date('2026-11-12T10:00:00Z'))).toBe('2026-11-09');
    expect(weekly([at({}), at({ failed: true }), at({ sentAt: new Date('2026-11-17T09:00:00Z'), replied: true })])).toEqual([
      { week: '2026-11-09', sent: 2, failed: 1, replied: 0 },
      { week: '2026-11-16', sent: 1, failed: 0, replied: 1 },
    ]);
  });

  it('gönderim saati önerisi yeterli yanıt yoksa yapılmaz, varsa en iyi üç saatlik dilimi verir', () => {
    expect(sendTimeGrid([at({})])).toEqual([{ weekday: 0, hour: 10, sent: 1, replied: 0 }]);
    const few = Array.from({ length: 10 }, () => at({ replied: true }));
    expect(suggestSendTime(sendTimeGrid(few))).toBeNull();
    const tuesdayMorning = Array.from({ length: MIN_REPLIES_FOR_SUGGESTION }, () => at({ sentAt: new Date('2026-11-10T06:00:00Z'), replied: true }));
    const mondayAfternoon = Array.from({ length: 20 }, (_, i) => at({ sentAt: new Date('2026-11-09T12:00:00Z'), replied: i < 5 }));
    expect(suggestSendTime(sendTimeGrid([...tuesdayMorning, ...mondayAfternoon]))).toEqual({ weekday: 1, fromHour: 9, toHour: 12, rate: 1, sent: MIN_REPLIES_FOR_SUGGESTION });
  });
});
