import { categorizeJobOpportunity, computeF, computeQ, EvidenceLike } from '../../src/domain/scoring';

const now = new Date('2026-09-30T10:00:00Z');
const ev = (p: Partial<EvidenceLike>): EvidenceLike => ({
  id: Math.random().toString(36).slice(2),
  dimension: 'customer',
  scope: 'local',
  claimType: 'dated_case',
  confidence: 'high',
  evidenceDate: '2026-03-01',
  customerName: 'Marka A',
  ...p,
});

describe('Q puanı', () => {
  it('kanıt yoksa boyut bilinmiyor ve coverage 0', () => {
    const r = computeQ([], {}, {}, now);
    expect(r.q).toBe(0);
    expect(r.coverage).toBe(0);
    expect(r.dims.customer.score).toBeNull();
  });

  it('bilinmeyen boyutlar normalize edilmez (az verili firma yükselmez)', () => {
    const r = computeQ([ev({})], {}, {}, now);
    expect(r.dims.customer.score).toBe(1);
    expect(r.q).toBe(35);
    expect(r.coverage).toBe(0.35);
  });

  it('global marka referansı yerel müşteri gibi puanlanmaz', () => {
    const r = computeQ([ev({ scope: 'global' }), ev({ scope: 'global', customerName: 'Marka B' })], {}, {}, now);
    expect(r.dims.customer.score).toBe(0.5);
  });

  it('logo duvarı zayıf kanıttır; eski vaka 0.5', () => {
    const r = computeQ(
      [ev({ claimType: 'logo_wall' }), ev({ dimension: 'campaign', evidenceDate: '2020-01-01', confidence: 'medium' })],
      {},
      {},
      now,
    );
    expect(r.dims.customer.score).toBe(0.5);
    expect(r.dims.campaign.score).toBe(0.5);
  });

  it('kullanıcı değerlendirmesi otomatik puanı ezer', () => {
    const r = computeQ([], { production: { score: 1 } }, {}, now);
    expect(r.dims.production.score).toBe(1);
    expect(r.q).toBe(10);
  });
});

describe('F puanı', () => {
  it('tam uyum 100', () => {
    const r = computeF({ titleMatch: 'exact', scope: 1, conditions: [{ key: 'a', label: 'a', required: true, met: true }], location: 'primary' });
    expect(r.f).toBe(100);
    expect(r.mandatoryUnknown).toBe(false);
  });

  it('zorunlu koşul bilinmiyorsa işaretlenir ve puana katkı vermez', () => {
    const r = computeF({ titleMatch: 'exact', scope: 1, conditions: [{ key: 'a', label: 'a', required: true, met: null }], location: 'primary' });
    expect(r.mandatoryUnknown).toBe(true);
    expect(r.f).toBe(80);
  });

  it('yakın rol ve koşullu bölge yarım puan', () => {
    const r = computeF({ titleMatch: 'adjacent', scope: 0.5, conditions: [], location: 'conditional' });
    expect(r.f).toBe(17.5 + 10 + 12.5);
  });
});

describe('kategori', () => {
  it('kaynak engelliyse teyit gerekli', () => {
    expect(categorizeJobOpportunity({ titleMatch: 'exact', jobStatus: 'open', sourceHealthy: false, hasConflict: false })).toBe('needs_confirmation');
  });
  it('açık exact hedef', () => {
    expect(categorizeJobOpportunity({ titleMatch: 'exact', jobStatus: 'open', sourceHealthy: true, hasConflict: false })).toBe('target_open');
    expect(categorizeJobOpportunity({ titleMatch: 'adjacent', jobStatus: 'open', sourceHealthy: true, hasConflict: false })).toBe('adjacent_open');
    expect(categorizeJobOpportunity({ titleMatch: 'exact', jobStatus: 'closed', sourceHealthy: true, hasConflict: false })).toBe('past_closed');
  });
});
