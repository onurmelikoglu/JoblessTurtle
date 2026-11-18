import { describe, expect, it } from 'vitest';
import type { HomeAddressSearch, IsoDate } from '@/api/types';
import { addressSearchNote, canAskOpus, opusQueueDays, planDescription, summaryLine } from './contact-search-model';

const DAY = 86_400_000;
const NOW = new Date('2026-11-11T09:00:00Z').getTime();
const iso = (ms: number) => new Date(ms).toISOString() as IsoDate;
const search = (patch: Partial<HomeAddressSearch> = {}): HomeAddressSearch => ({ searchedAt: iso(NOW - 12 * DAY), found: false, emptyStreak: 1, nextAt: iso(NOW + 18 * DAY), opusAt: null, ...patch });

describe('adres araması özeti', () => {
  it('takvim cümlesi gün listesinden kurulur', () => {
    expect(planDescription([7, 30, 90])).toBe('İlk sonuçsuz aramadan 7 gün sonra, olmazsa 30 gün sonra, sonra 90 günde bir yeniden aranır.');
  });

  it('Opus sırası günlük hakka bölünür', () => {
    expect(opusQueueDays({ awaitingOpus: 112 }, 15)).toBe(8);
    expect(opusQueueDays({ awaitingOpus: 0 }, 15)).toBe(0);
  });

  it('Opus kapalıysa özet Opus satırı içermez', () => {
    const summary = { withoutAddress: 121, awaitingOpus: 112, opusUsedToday: 3, dueNow: 4 };
    expect(summaryLine(summary, { opusRetry: true, opusDailyLimit: 15 })).toHaveLength(3);
    expect(summaryLine(summary, { opusRetry: false, opusDailyLimit: 15 })).toHaveLength(1);
  });

  it('kart notu ne zaman arandığını, Opus durumunu ve sonraki aramayı söyler', () => {
    expect(addressSearchNote(search(), NOW)).toMatch(/^12 gün önce arandı · .+ tarihinde kendiliğinden yeniden aranacak$/);
    expect(addressSearchNote(search({ emptyStreak: 3, opusAt: iso(NOW - DAY), nextAt: iso(NOW - DAY) }), NOW)).toBe('12 gün önce arandı, art arda 3. sonuçsuz arama · Opus ile de arandı · sonraki aramada yeniden aranacak');
    expect(addressSearchNote(search({ found: true }), NOW)).toBeNull();
    expect(addressSearchNote(null, NOW)).toBeNull();
  });

  it('Opus önerisi yalnız hiç Opus ile aranmamış, adressiz firmada çıkar', () => {
    expect(canAskOpus(search())).toBe(true);
    expect(canAskOpus(search({ opusAt: iso(NOW) }))).toBe(false);
    expect(canAskOpus(search({ found: true }))).toBe(false);
    expect(canAskOpus(null)).toBe(false);
  });
});
