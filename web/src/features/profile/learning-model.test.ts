import { describe, expect, it } from 'vitest';
import type { IsoDate, LearnedModelSummary } from '@/api/types';
import { bounceText, effectText, effectTone, modelStatus, modelTitle, weekLabel } from './learning-model';

function model(patch: Partial<LearnedModelSummary>): LearnedModelSummary {
  return { name: 'delivery', label: 'Teslim: adres mail alıyor mu', scope: null, trainedAt: '2026-10-14T03:00:00Z' as IsoDate, active: false, inactiveReason: 'few_samples', samples: 40, positives: 34, baseRate: 0.85, gain: 0, auc: null, effects: [], ...patch };
}

describe('öğrenme ekranı', () => {
  it('kullanılmayan modelin nedeni ve örnek sayısı yazılır', () => {
    expect(modelStatus(model({}))).toBe('Yeterli örnek birikmedi; kullanılmıyor · 40 örnek');
    expect(modelStatus(model({ inactiveReason: 'no_gain', samples: 207 }))).toBe('Denenmemiş örneklerde temel orandan iyi tahmin edemiyor; kullanılmıyor · 207 örnek');
    expect(modelStatus(model({ inactiveReason: 'few_of_one_outcome', samples: 300 }))).toContain('çok az görüldü');
  });

  it('kullanılan modelin temel oranı, isabeti ve kazancı yazılır', () => {
    expect(modelStatus(model({ active: true, inactiveReason: null, samples: 352, baseRate: 0.787, gain: 0.124, auc: 0.8249 }))).toBe('Kullanılıyor · 352 örnek · temel oran %79 · sıralama isabeti 0,82 · temel orana göre %12 daha iyi');
  });

  it('kişisel modelde çalışma alanı adı başlıkta görünür', () => {
    expect(modelTitle(model({}))).toBe('Teslim: adres mail alıyor mu');
    expect(modelTitle(model({ label: 'İlgi', scope: 'Ayşe çalışma alanı' }))).toBe('İlgi (Ayşe çalışma alanı)');
  });

  it('özellik etkileri Türkçe adlarıyla ve oranıyla yazılır', () => {
    const effect = { feature: 'sourceType', value: 'other_site', samples: 90, rate: 0.4, weight: -1.2 };
    expect(effectText(effect)).toBe('Adresin bulunduğu yer: üçüncü taraf site — %40 (90 örnek)');
    expect(effectTone(effect, 0.85)).toBe('bad');
    expect(effectTone({ ...effect, rate: 0.93 }, 0.85)).toBe('good');
    expect(effectText({ feature: 'yeni', value: 'değer', samples: 9, rate: 1, weight: 0.1 })).toBe('yeni: değer — %100 (9 örnek)');
  });

  it('haftalık satır tarihi ve geri dönüş oranını gösterir', () => {
    const row = { week: '2026-10-05', sent: 60, delivered: 44, bounced: 6, replied: 2, pending: 10, bounceRate: 0.1 };
    expect(weekLabel(row)).toBe('5 Eki 2026 haftası');
    expect(bounceText(row)).toBe('%10');
  });
});
