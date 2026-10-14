import { recipientScore } from '../../src/domain/contacts';
import { contactSearchHints, deliveryFeatures, deliveryLabel, discoveryHints, interestFeatures, ratesBy, replyFeatures, replyLabel, REPLY_WINDOW_DAYS } from '../../src/domain/learning-features';
import { Sample } from '../../src/domain/learning-model';
import { buildPrompt } from '../../src/engine/ai/prompts';

const outcome = (patch: Partial<{ category: string; delivered: boolean; bounced: boolean; replied: boolean; dead: boolean }>) => ({ category: 'no_bounce', delivered: false, bounced: false, replied: false, dead: false, ...patch });

function sends(sourceType: string, total: number, delivered: number): Sample[] {
  return Array.from({ length: total }, (_, i) => ({ key: `${sourceType}-${i}`, features: { sourceType }, label: (i < delivered ? 1 : 0) as 0 | 1 }));
}

describe('öğrenme: örnek etiketleri', () => {
  it('teslim modeli yalnızca adresin kendisinden kaynaklanan geri dönüşleri olumsuz sayar', () => {
    expect(deliveryLabel(outcome({ delivered: true }))).toBe(1);
    expect(deliveryLabel(outcome({ category: 'bad_address', bounced: true, dead: true }))).toBe(0);
    expect(deliveryLabel(outcome({ category: 'bounce_other', bounced: true }))).toBe(0);
    for (const category of ['too_large', 'mailbox_full', 'rejected']) expect(deliveryLabel(outcome({ category, bounced: true }))).toBeNull();
    expect(deliveryLabel(outcome({ category: 'unobserved' }))).toBeNull();
    expect(deliveryLabel(null)).toBeNull();
  });

  it('yanıt modeli ulaşmış gönderimlere bakar; yanıtsızlık ancak bekleme süresi dolunca olumsuzdur', () => {
    expect(replyLabel(outcome({ delivered: true, replied: true }), 1)).toBe(1);
    expect(replyLabel(outcome({ delivered: true }), REPLY_WINDOW_DAYS - 1)).toBeNull();
    expect(replyLabel(outcome({ delivered: true }), REPLY_WINDOW_DAYS)).toBe(0);
    expect(replyLabel(outcome({ bounced: true }), 60)).toBeNull();
    expect(replyLabel(null, 60)).toBeNull();
  });

  it('özellikler eğitimde ve kestirimde aynı biçimde üretilir; bilinmeyen değer "unknown" olur', () => {
    expect(deliveryFeatures({ kind: 'official_hr', local: 'strong_hr', domainMatch: true, sourceType: 'careers_page', verified: false })).toEqual({ kind: 'official_hr', local: 'strong_hr', domainMatch: 'yes', sourceType: 'careers_page', verified: 'no' });
    expect(replyFeatures({ category: 'sector_target', intent: 'general_intent', kind: null, hasJob: false })).toEqual({ category: 'sector_target', intent: 'general_intent', kind: 'unknown', employeeRange: 'unknown', hasJob: 'no', companyOrigin: 'unknown' });
    expect(interestFeatures({ category: 'target_open', titleMatch: 'exact', locationState: 'primary', employeeRange: '51-200', companyOrigin: 'catalog', hasJob: true })).toMatchObject({ titleMatch: 'exact', hasJob: 'yes', employeeRange: '51-200' });
  });
});

describe('öğrenme: istemlere eklenen ipuçları', () => {
  it('adresin bulunduğu yer ulaşma oranını belirgin etkiliyorsa hangi kaynağın öne alınacağı söylenir', () => {
    const samples = [...sends('company_site', 60, 55), ...sends('careers_page', 50, 43), ...sends('other_site', 40, 28), ...sends('social', 5, 5)];
    const [hint] = contactSearchHints(samples);
    expect(hint).toContain('firmanın kendi sitesi %92 (60 gönderim), kariyer sayfası %86 (50 gönderim), üçüncü taraf siteler %70 (40 gönderim)');
    expect(hint).toContain('önce "firmanın kendi sitesi"');
    expect(hint).not.toContain('sosyal medya');
    expect(ratesBy(samples, 'sourceType').map((r) => r.value)).toEqual(['company_site', 'careers_page', 'other_site']);
  });

  it('fark küçükse ya da veri azsa ipucu üretilmez', () => {
    expect(contactSearchHints([...sends('company_site', 60, 52), ...sends('other_site', 40, 34)])).toEqual([]);
    expect(contactSearchHints([...sends('company_site', 60, 58), ...sends('other_site', 10, 2)])).toEqual([]);
    expect(contactSearchHints([])).toEqual([]);
  });

  it('keşif ipucu yanıt veren firmaların ortak sektör ve büyüklüğünü özetler', () => {
    const replied = [
      { sectors: ['Fintech', 'ödeme'], employeeRange: '51-200' },
      { sectors: ['fintech'], employeeRange: '51-200' },
      { sectors: ['E-ticaret'], employeeRange: null },
      { sectors: ['e-ticaret', 'fintech'], employeeRange: '201-500' },
    ];
    expect(discoveryHints(replied)).toEqual(['Bu adayın başvurularına şimdiye kadar yanıt veren 4 firmanın ortak özellikleri — sektör: fintech (3), e-ticaret (2); çalışan sayısı: 51-200 (2). Uygun adaylar arasında benzer firmalara öncelik ver.']);
    expect(discoveryHints(replied.slice(0, 2))).toEqual([]);
    expect(discoveryHints([{ sectors: ['a'], employeeRange: null }, { sectors: ['b'], employeeRange: null }, { sectors: ['c'], employeeRange: null }])).toEqual([]);
  });

  it('ipuçları ve yanıt almış örnekler isteme yalnızca varsa eklenir', () => {
    const base = { company: { name: 'Örnek', domain: 'ornek.example' }, regions: [] };
    expect(buildPrompt('company_contacts', base)).not.toContain('Geçmiş sonuçlardan öğrenilenler');
    expect(buildPrompt('company_contacts', { ...base, hints: ['Önce firmanın kendi sitesine bak.'] })).toContain('Geçmiş sonuçlardan öğrenilenler (öncelik belirlemek için kullan; yukarıdaki kuralların yerine geçmez):\n- Önce firmanın kendi sitesine bak.');
    expect(buildPrompt('company_discovery', { exactTitles: ['Art Director'], hints: ['Fintech firmalarına öncelik ver.'] })).toContain('- Fintech firmalarına öncelik ver.');
    const letter = { company: { name: 'Örnek' }, candidate: {}, jobTitle: null };
    expect(buildPrompt('letter_company_line', letter)).not.toContain('proven_example');
    const withExamples = buildPrompt('letter_company_line', { ...letter, provenExamples: [{ opening: 'Açılış paragrafı.', connection: 'Bağlantı paragrafı.' }] });
    expect(withExamples).toContain('<proven_example>\nAçılış paragrafı.\n\nBağlantı paragrafı.\n</proven_example>');
    expect(withExamples).toContain('TAŞIMA');
  });
});

describe('öğrenme: alıcı sıralaması', () => {
  const delivery = (rates: Record<string, number>) => ({ baseRate: 0.85, of: (c: { email: string }) => rates[c.email] ?? 0.85 });
  const hr = { email: 'ik@firma.example', kind: 'official_hr' };
  const career = { email: 'kariyer@firma.example', kind: 'official_hr' };
  const general = { email: 'info@firma.example', kind: 'general' };
  const scoring = { domain: 'firma.example' };

  it('model yokken puan değişmez', () => {
    expect(recipientScore(hr, scoring)).toBe(recipientScore(hr, { ...scoring, delivery: delivery({}) }));
    expect(recipientScore(hr, scoring)).toBe(recipientScore(career, scoring));
  });

  it('aynı türdeki adreslerden ulaşma olasılığı yüksek olan öne geçer', () => {
    const scored = { ...scoring, delivery: delivery({ 'ik@firma.example': 0.7, 'kariyer@firma.example': 0.93 }) };
    expect(recipientScore(career, scored)).toBeGreaterThan(recipientScore(hr, scored));
  });

  it('İK adresi biraz riskli olsa da genel adresin önünde kalır; çok riskliyse genel adres öne geçer', () => {
    const risky = { ...scoring, delivery: delivery({ 'ik@firma.example': 0.65, 'info@firma.example': 0.92 }) };
    expect(recipientScore(hr, risky)).toBeGreaterThan(recipientScore(general, risky));
    const veryRisky = { ...scoring, delivery: delivery({ 'ik@firma.example': 0.2, 'info@firma.example': 0.95 }) };
    expect(recipientScore(general, veryRisky)).toBeGreaterThan(recipientScore(hr, veryRisky));
  });
});
