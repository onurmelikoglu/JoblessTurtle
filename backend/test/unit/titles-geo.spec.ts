import { detectLocation, evaluateLocation, regionForSelection, regionForSelections } from '../../src/domain/geo';
import { classifyTitle, normalizeTitle } from '../../src/domain/titles';

const rules = {
  exactTitles: ['Kreatif Direktör', 'Creative Director', 'Creative Lead'],
  adjacentTitles: ['Creative Producer', 'Head of Creative', 'Art Director'],
  excludedTitles: ['Sales Director', 'IT Director', 'Fashion Product Design Director'],
};

describe('unvan normalizasyonu', () => {
  it('TR ve EN varyantları aynı forma indirger', () => {
    expect(normalizeTitle('Kreatif Direktör')).toBe('creative director');
    expect(normalizeTitle('CREATIVE-DIRECTOR')).toBe('creative director');
    expect(normalizeTitle('Kreatif Direktörü')).toBe('creative director');
  });

  it('exact / adjacent / excluded ayrımı', () => {
    expect(classifyTitle('Senior Creative Director', rules).match).toBe('exact');
    expect(classifyTitle('Kreatif Direktör (Film)', rules).match).toBe('exact');
    expect(classifyTitle('Head of Creative', rules).match).toBe('adjacent');
    expect(classifyTitle('Sales Director', rules).match).toBe('excluded');
    expect(classifyTitle('Backend Developer', rules).match).toBe('none');
  });

  it('associate öneki exact eşleşmeyi yakın role düşürür', () => {
    expect(classifyTitle('Associate Creative Director', rules).match).toBe('adjacent');
  });
});

describe('konum', () => {
  const region = {
    city: 'İstanbul',
    districtsPrimary: ['Kadıköy', 'Üsküdar', 'Ataşehir', 'Ümraniye'],
    districtsConditional: ['Şişli', 'Beşiktaş', 'Levent'],
    allowRemote: false,
    allowHybrid: true,
  };

  it('ilçe ve semt tespiti', () => {
    expect(detectLocation('Kozyatağı, Kadıköy / İstanbul').district).toBe('Kadıköy');
    expect(detectLocation('Levent, İstanbul').district).toBe('Beşiktaş');
    expect(detectLocation('Istanbul, Turkey').city).toBe('İstanbul');
  });

  it('görev ofisi esas alınır; belirsiz konum unknown kalır', () => {
    expect(evaluateLocation(region, 'Ataşehir, İstanbul')).toBe('primary');
    expect(evaluateLocation(region, 'Levent')).toBe('conditional');
    expect(evaluateLocation(region, 'Bakırköy, İstanbul')).toBe('outside');
    expect(evaluateLocation(region, 'İstanbul')).toBe('unknown');
    expect(evaluateLocation(region, 'Ankara')).toBe('outside');
    expect(evaluateLocation(region, null)).toBe('unknown');
  });

  it('uzaktan çalışma yalnızca izin varsa kabul edilir', () => {
    expect(evaluateLocation(region, 'Remote')).toBe('outside');
    expect(evaluateLocation({ ...region, allowRemote: true }, 'Remote')).toBe('remote');
  });
});

describe('Şehir seçimi', () => {
  it('İstanbul yakası seçimi o yakanın ilçelerine çevrilir', () => {
    const anadolu = regionForSelection('İstanbul (Anadolu Yakası)');
    expect(anadolu.city).toBe('İstanbul');
    expect(anadolu.districtsPrimary).toContain('Kadıköy');
    expect(anadolu.districtsPrimary).not.toContain('Beşiktaş');
    expect(evaluateLocation({ ...anadolu, districtsConditional: [], allowRemote: false, allowHybrid: true }, 'Ataşehir, İstanbul')).toBe('primary');
    expect(evaluateLocation({ ...anadolu, districtsConditional: [], allowRemote: false, allowHybrid: true }, 'Maslak, İstanbul')).toBe('outside');
  });

  it('diğer şehirler kendi adıyla eşleşir, boş seçim bölge koymaz', () => {
    expect(regionForSelection('Ankara')).toEqual({ city: 'Ankara', districtsPrimary: ['Ankara'] });
    expect(regionForSelection('')).toEqual({ city: null, districtsPrimary: [] });
  });
});

describe('Çoklu şehir seçimi', () => {
  it('birden çok seçim ilçe ve şehirleri birleştirir; tek şehirde şehir korunur', () => {
    const multi = regionForSelections(['İstanbul (Anadolu Yakası)', 'Kocaeli']);
    expect(multi.city).toBeNull();
    expect(multi.districtsPrimary).toEqual(expect.arrayContaining(['Kadıköy', 'Kocaeli']));
    expect(evaluateLocation({ ...multi, districtsConditional: [], allowRemote: false, allowHybrid: true }, 'Gebze, Kocaeli')).toBe('primary');
    const sides = regionForSelections(['İstanbul (Anadolu Yakası)', 'İstanbul (Avrupa Yakası)']);
    expect(sides.city).toBe('İstanbul');
    expect(sides.districtsPrimary).toEqual(expect.arrayContaining(['Kadıköy', 'Beşiktaş']));
  });
});
