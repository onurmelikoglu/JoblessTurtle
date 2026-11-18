import { findTwins, strictCoreOf, TwinProfile, twinVerdict } from '../../src/domain/company-twins';

const firm = (id: string, name: string, patch: Partial<TwinProfile> = {}): TwinProfile => ({ id, name, domains: [], jobs: [], emailDomains: [], officePlaces: [], ...patch });
const job = { title: 'dijital pazarlama ve sosyal medya uzmani', place: 'Kocaeli Körfez' };

describe('aynı firmanın kayıtları', () => {
  it('ad çekirdeği hukuki ekleri ve sektör kısaltmalarını atar', () => {
    expect(strictCoreOf('DURU TAŞ LTD ŞTİ')).toBe('duru tas');
    expect(strictCoreOf('DURU TAŞ YAPI İNŞ. LTD. ŞTİ.')).toBe('duru tas');
    expect(strictCoreOf('Yeşil Vadi Gıda San. ve Tic. A.Ş.')).toBe('yesil vadi');
  });

  it('aynı ad çekirdeği ve aynı ilan kesin aynıdır', () => {
    const verdict = twinVerdict(firm('a', 'DURU TAŞ LTD ŞTİ', { jobs: [job] }), firm('b', 'DURU TAŞ YAPI İNŞ. LTD. ŞTİ.', { jobs: [job], officePlaces: ['Körfez Kocaeli'] }));
    expect(verdict?.level).toBe('certain');
    expect(verdict?.reasons).toContain('Aynı ilan: dijital pazarlama ve sosyal medya uzmani');
  });

  it('aynı web sitesi kesin aynıdır; kanıt yoksa yalnız öneridir', () => {
    expect(twinVerdict(firm('a', 'Kartal Ödeme', { domains: ['kartalodeme.com'] }), firm('b', 'Kartal Ödeme Hizmetleri', { domains: ['www.kartalodeme.com.tr'] }))?.level).toBe('certain');
    expect(twinVerdict(firm('a', 'DURU TAŞ LTD ŞTİ'), firm('b', 'DURU TAŞ YAPI İNŞ. LTD. ŞTİ.'))?.level).toBe('likely');
  });

  it('tek ve kısa çekirdek, farklı web siteleri ya da farklı ad otomatik birleştirilmez', () => {
    expect(twinVerdict(firm('a', 'Duru Yazılım', { jobs: [job] }), firm('b', 'Duru Medya', { jobs: [job] }))?.level).toBe('likely');
    expect(twinVerdict(firm('a', 'Duru Taş', { jobs: [job], domains: ['durutas.com'] }), firm('b', 'Duru Taş Yapı', { jobs: [job], domains: ['durutasyapi.com'] }))).toMatchObject({ level: 'likely', reasons: expect.arrayContaining(['Ancak web siteleri farklı']) });
    expect(twinVerdict(firm('a', 'Unda Studio'), firm('b', 'Unda Sigorta'))).toBeNull();
    expect(twinVerdict(firm('a', 'Mavi Yazılım'), firm('b', 'Kırmızı Yazılım'))).toBeNull();
  });

  it('aynı site ancak adların başıyla örtüşüyorsa kesindir; yanlış atanmış site öneri olur', () => {
    expect(twinVerdict(firm('a', 'Lodos Engage Istanbul', { domains: ['lodos.com'] }), firm('b', 'Lodos Türkiye (Lodos İstanbul)', { domains: ['lodos.com'] }))?.level).toBe('certain');
    expect(twinVerdict(firm('a', 'Mavi Yelken Turizm', { domains: ['maviyelken.com.tr'] }), firm('b', 'MAVİ YELKEN TURİZM VE SEYAHAT', { domains: ['maviyelken.com.tr'] }))?.level).toBe('certain');
    expect(twinVerdict(firm('a', 'Üç Kavak Ilgaz Giyim San. ve Tic. A.Ş.', { domains: ['ilgaz.com'] }), firm('b', 'Ilgaz Züccaciye', { domains: ['ilgaz.com'] }))?.level).toBe('likely');
  });

  it('çiftler bir kez döner', () => {
    const twins = findTwins([firm('x', 'DURU TAŞ LTD ŞTİ', { jobs: [job] }), firm('y', 'DURU TAŞ YAPI İNŞ. LTD. ŞTİ.', { jobs: [job] }), firm('z', 'Başka Firma')]);
    expect(twins.map((t) => [t.a.id, t.b.id, t.verdict.level])).toEqual([['x', 'y', 'certain']]);
  });
});
