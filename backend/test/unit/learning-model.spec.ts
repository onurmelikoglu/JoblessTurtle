import { areaUnderCurve, crossValidate, DEFAULT_TRAINING, fitModel, predict, Sample, trainLogistic } from '../../src/domain/learning-model';

/** Belirlenimci sözde rastgele sayı: testler her çalıştırmada aynı veriyi üretir. */
function generator(seed: number) {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function synthetic(count: number, rates: Record<string, number>, seed = 7): Sample[] {
  const random = generator(seed);
  const sources = Object.keys(rates);
  return Array.from({ length: count }, (_, i) => {
    const source = sources[Math.floor(random() * sources.length)];
    const noise = random() < 0.5 ? 'a' : 'b';
    return { key: `s${i}`, features: { source, noise }, label: random() < rates[source] ? 1 : 0 } as Sample;
  });
}

describe('hafif model: lojistik regresyon', () => {
  const data = synthetic(600, { site: 0.92, careers: 0.85, other: 0.6 });

  it('özelliğin gerçek etkisini öğrenir, etkisiz özelliğe ağırlık vermez', () => {
    const model = trainLogistic(data);
    const site = predict(model, { source: 'site', noise: 'a' });
    const other = predict(model, { source: 'other', noise: 'a' });
    expect(site).toBeGreaterThan(0.87);
    expect(other).toBeLessThan(0.72);
    expect(Math.abs(model.weights['noise=a'] - model.weights['noise=b'])).toBeLessThan(0.4);
  });

  it('görülmemiş değer ve özellik temel orana düşer', () => {
    const model = trainLogistic(data);
    const baseRate = data.filter((s) => s.label === 1).length / data.length;
    expect(predict(model, {})).toBeCloseTo(1 / (1 + Math.exp(-model.intercept)), 10);
    expect(Math.abs(predict(model, { source: 'hiç-görülmedi' }) - predict(model, {}))).toBe(0);
    expect(Math.abs(predict(model, {}) - baseRate)).toBeLessThan(0.12);
  });

  it('aynı veriyle her zaman aynı modeli üretir', () => {
    expect(trainLogistic(data)).toEqual(trainLogistic([...data].reverse()));
  });

  it('az örnekte ağırlıklar temel orana doğru çekilir', () => {
    const few: Sample[] = [
      ...Array.from({ length: 9 }, (_, i) => ({ key: `a${i}`, features: { source: 'site' }, label: 1 as const })),
      ...Array.from({ length: 9 }, (_, i) => ({ key: `b${i}`, features: { source: 'other' }, label: (i < 6 ? 1 : 0) as 0 | 1 })),
    ];
    const model = trainLogistic(few);
    expect(predict(model, { source: 'site' })).toBeLessThan(0.97);
    expect(predict(model, { source: 'other' })).toBeGreaterThan(0.67);
    expect(predict(model, { source: 'site' })).toBeGreaterThan(predict(model, { source: 'other' }));
  });

  it('tek sonuçlu ya da boş veride yalnızca temel oranı döndürür', () => {
    expect(trainLogistic([])).toEqual({ intercept: 0, weights: {} });
    const allPositive = Array.from({ length: 30 }, (_, i) => ({ key: `p${i}`, features: { source: 'site' }, label: 1 as const }));
    expect(trainLogistic(allPositive).weights).toEqual({});
    expect(predict(trainLogistic(allPositive), { source: 'site' })).toBeGreaterThan(0.99);
  });

  it('birbirini tekrarlayan özelliklerde ve neredeyse ayrışan veride de dengeli kalır', () => {
    const random = generator(3);
    const rows: Sample[] = Array.from({ length: 700 }, (_, i) => {
      const general = i % 14 === 0;
      const thirdParty = !general && i % 8 === 1;
      const rate = thirdParty ? 0.4 : general ? 0.94 : 0.975;
      return { key: `c${i}`, features: { kind: general ? 'general' : 'official_hr', local: general ? 'general' : 'strong_hr', sourceType: thirdParty ? 'other_site' : 'company_site', domainMatch: thirdParty ? 'no' : 'yes' }, label: random() < rate ? 1 : 0 } as Sample;
    });
    const model = fitModel('eşdoğrusal', rows);
    expect(Math.max(...Object.values(model.weights).map(Math.abs))).toBeLessThan(3);
    expect(model.metrics.gain).toBeGreaterThan(0.1);
    expect(model.active).toBe(true);
    expect(predict(model, { kind: 'official_hr', local: 'strong_hr', sourceType: 'other_site', domainMatch: 'no' })).toBeLessThan(0.55);
    expect(predict(model, { kind: 'official_hr', local: 'strong_hr', sourceType: 'company_site', domainMatch: 'yes' })).toBeGreaterThan(0.93);
  });

  it('nadir değerler kendi ağırlığını almaz', () => {
    const withRare = [...data, { key: 'rare', features: { source: 'tek', noise: 'a' }, label: 0 as const }];
    expect(trainLogistic(withRare).weights['source=tek']).toBeUndefined();
  });
});

describe('hafif model: ölçme ve etkinleştirme', () => {
  it('sinyal varsa çapraz doğrulamada temel orandan iyidir ve etkinleşir', () => {
    const model = fitModel('teslim', synthetic(600, { site: 0.95, careers: 0.85, other: 0.5 }), DEFAULT_TRAINING, new Date('2026-10-14T00:00:00Z'));
    expect(model.active).toBe(true);
    expect(model.inactiveReason).toBeNull();
    expect(model.metrics.gain).toBeGreaterThan(0.03);
    expect(model.metrics.auc).toBeGreaterThan(0.6);
    expect(model.metrics.logLoss).toBeLessThan(model.metrics.baselineLogLoss);
    expect(model.features).toEqual(['noise', 'source']);
    expect(model.trainedAt).toBe('2026-10-14T00:00:00.000Z');
    expect(model.effects[0]).toMatchObject({ feature: 'source', value: 'other' });
    expect(model.effects[0].rate).toBeLessThan(0.6);
  });

  it('sinyal yoksa etkinleşmez', () => {
    const model = fitModel('gürültü', synthetic(600, { site: 0.8, careers: 0.8, other: 0.8 }, 11));
    expect(model.active).toBe(false);
    expect(model.inactiveReason).toBe('no_gain');
    expect(model.metrics.gain).toBeLessThan(0.01);
  });

  it('örnek ya da azınlık sonucu yetersizse etkinleşmez', () => {
    expect(fitModel('az', synthetic(60, { site: 0.95, other: 0.4 }))).toMatchObject({ active: false, inactiveReason: 'few_samples' });
    const lopsided = synthetic(400, { site: 0.99, other: 0.97 });
    expect(fitModel('tek-yanlı', lopsided)).toMatchObject({ active: false, inactiveReason: 'few_of_one_outcome' });
    expect(fitModel('boş', [])).toMatchObject({ active: false, inactiveReason: 'few_samples', metrics: { samples: 0, auc: null } });
  });

  it('ölçütler kat dışı tahminlerden hesaplanır ve kararlıdır', () => {
    const data = synthetic(300, { site: 0.9, other: 0.6 });
    expect(crossValidate(data)).toEqual(crossValidate([...data].reverse()));
    expect(crossValidate(data).samples).toBe(300);
  });

  it('AUC sıralamayı ölçer; eşit puanlar yarım sayılır', () => {
    expect(areaUnderCurve([{ score: 0.9, label: 1 }, { score: 0.1, label: 0 }])).toBe(1);
    expect(areaUnderCurve([{ score: 0.1, label: 1 }, { score: 0.9, label: 0 }])).toBe(0);
    expect(areaUnderCurve([{ score: 0.5, label: 1 }, { score: 0.5, label: 0 }])).toBe(0.5);
    expect(areaUnderCurve([{ score: 0.5, label: 1 }])).toBeNull();
  });
});
