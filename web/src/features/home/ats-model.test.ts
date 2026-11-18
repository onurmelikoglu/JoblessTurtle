import { describe, expect, it } from 'vitest';
import type { HomeAtsOverview } from '@/api/types';
import { atsTone, attachedIsAts, betterVersion, improvementText, needsImprovement, scoreOf } from './ats-model';

const ats = (patch: Partial<HomeAtsOverview> = {}): HomeAtsOverview => ({
  status: 'ready',
  threshold: 70,
  items: [
    { documentId: 'o', variant: 'original', label: 'CV TR v1', score: 54, missing: ['Go'], addedSkills: [], attached: true },
    { documentId: 'm', variant: 'ats_main', label: 'CV TR — ATS', score: 82, missing: [], addedSkills: ['Go'], attached: false },
  ],
  best: { documentId: 'm', score: 82 },
  attachedScore: 54,
  ...patch,
});

describe('ATS görünümü', () => {
  it('oran rengi eşiğe göre', () => {
    expect([atsTone(85, 70), atsTone(65, 70), atsTone(40, 70)]).toEqual(['good', 'warn', 'bad']);
  });

  it('ekli CV düşükse iyileştirme önerilir; daha iyi hazır sürüm varsa eklenmesi önerilir', () => {
    expect(needsImprovement(ats())).toBe(true);
    expect(betterVersion(ats())?.documentId).toBe('m');
    expect(scoreOf(ats(), 'm')).toBe(82);
    const good = ats({ attachedScore: 82, items: ats().items.map((i) => ({ ...i, attached: i.documentId === 'm' })) });
    expect(needsImprovement(good)).toBe(false);
    expect(betterVersion(good)).toBeNull();
    expect(needsImprovement(ats({ status: 'preparing' }))).toBe(false);
  });

  it('ekli CV ATS sürümüyse düğme yeniden iyileştirir', () => {
    expect(attachedIsAts(ats())).toBe(false);
    expect(attachedIsAts(ats({ items: ats().items.map((i) => ({ ...i, attached: i.documentId === 'm' })) }))).toBe(true);
    expect(attachedIsAts(ats({ status: 'preparing' }))).toBe(false);
  });

  it('iyileştirme sonucu metni', () => {
    expect(improvementText(54, 82)).toBe('ATS uyumu %54 → %82');
    expect(improvementText(null, 82)).toBe('ATS uyumu %82');
  });
});
