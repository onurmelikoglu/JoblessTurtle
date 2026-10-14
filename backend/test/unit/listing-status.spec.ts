import { mergeJobStatus, nextListingState } from '../../src/domain/listing-status';

const open = { status: 'open' as const, missingCount: 0, openCycle: 1 };
const now = new Date('2026-09-30T10:00:00Z');

describe('ilan durum kuralları', () => {
  it('403 / timeout / eksik tarama kapanış üretmez', () => {
    for (const reason of ['forbidden', 'timeout', 'rate_limited', 'partial'] as const) {
      expect(nextListingState(open, { kind: 'fetch_failed', reason }).status).toBe('open');
    }
    expect(nextListingState(open, { kind: 'absent', crawlComplete: false }).status).toBe('open');
  });

  it('tek kaybolma kapanış değildir; ardışık yokluk + detay 404 kapatır', () => {
    const s1 = nextListingState(open, { kind: 'absent', crawlComplete: true, detail: 'not_found' });
    expect(s1.status).toBe('open');
    expect(s1.missingCount).toBe(1);
    const s2 = nextListingState(s1, { kind: 'absent', crawlComplete: true, detail: 'not_found' });
    expect(s2.status).toBe('closed');
    expect(s2.closedNow).toBe(true);
  });

  it('ardışık yokluk ama detay kontrol edilemedi → unknown', () => {
    const s1 = nextListingState(open, { kind: 'absent', crawlComplete: true, detail: 'unavailable' });
    const s2 = nextListingState(s1, { kind: 'absent', crawlComplete: true, detail: 'unavailable' });
    expect(s2.status).toBe('unknown');
  });

  it('açık kapalı ibaresi veya süresi geçmiş validThrough güçlü kapanış', () => {
    expect(nextListingState(open, { kind: 'present', closedMarker: true, now }).status).toBe('closed');
    expect(nextListingState(open, { kind: 'present', validThrough: new Date('2026-01-01'), now }).status).toBe('closed');
  });

  it('yeniden açılma openCycle artırır', () => {
    const closed = { status: 'closed' as const, missingCount: 2, openCycle: 1 };
    const r = nextListingState(closed, { kind: 'present', now });
    expect(r.status).toBe('open');
    expect(r.reopened).toBe(true);
    expect(r.openCycle).toBe(2);
  });

  it('resmî kapanış ikincil kaynaktaki açık kopya ile açılmaz; çelişki görünür', () => {
    const r = mergeJobStatus([
      { isOfficial: true, status: 'closed', lastVerifiedAt: now, sourceHealthy: true },
      { isOfficial: false, status: 'open', lastVerifiedAt: now, sourceHealthy: true },
    ]);
    expect(r.status).toBe('closed');
    expect(r.conflict).toBeTruthy();
  });
});
