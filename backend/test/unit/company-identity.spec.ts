import { appliedCompanyJobNotice, isFreshListing } from '../../src/domain/applied-companies';
import { CompanyIdentityIndex, domainRootOf, identityKeysOf, nameKeysOf } from '../../src/domain/company-identity';

const company = (id: string, name: string, canonicalDomain: string | null = null, website: string | null = null) => ({ id, name, canonicalDomain, website });

describe('firma kimliği', () => {
  it('alan adı kökü ülke ve kurum uzantılarından bağımsızdır', () => {
    expect(domainRootOf('kartalodeme.com')).toBe('kartalodeme');
    expect(domainRootOf('www.kartalodeme.com.tr')).toBe('kartalodeme');
    expect(domainRootOf('https://dalga.agency/tr')).toBe('dalga');
    expect(domainRootOf('martikoleji.k12.tr')).toBe('martikoleji');
    expect(domainRootOf('abc.com')).toBeNull();
    expect(domainRootOf('kabuk.github.io')).toBeNull();
    expect(domainRootOf('firma.wixsite.com')).toBeNull();
    expect(domainRootOf(null)).toBeNull();
  });

  it('ad anahtarı yer, hukuki ve genel ekleri atar; parantez içindeki diğer adı da alır', () => {
    expect(nameKeysOf('Kartal Ödeme (Türkiye / İstanbul)')).toEqual(['kartal odeme']);
    expect(nameKeysOf('Kartal Ödeme (İstanbul)')).toEqual(['kartal odeme']);
    expect(nameKeysOf('Yosun Istanbul (Yosun Engage)')).toEqual(['yosun', 'yosun engage']);
    expect(nameKeysOf('Pırıl TR Teknoloji Ticaret Limited Şirketi')).toEqual(['piril']);
    expect(nameKeysOf('Pırıl Türkiye (Pırıl Teknoloji Ticaret Limited Şirketi)')).toEqual(['piril']);
    expect(nameKeysOf('Teknoloji A.Ş.')).toEqual([]);
  });

  it('aynı firmanın farklı kayıtları eşleşir, benzer adlı farklı firmalar eşleşmez', () => {
    const applied = new CompanyIdentityIndex([
      company('a1', 'Kartal Ödeme (İstanbul)', 'kartalodeme.com'),
      company('a2', 'Yosun Engage Istanbul', 'yosun.com'),
      company('a3', 'Pırıl TR Teknoloji Ticaret Limited Şirketi'),
      company('a4', 'DALGA Agency (İstanbul)', 'dalga.agency'),
      company('a5', 'Mavi Games', 'mavi.gs'),
      company('a6', 'Unda Sigorta A.Ş.', 'undasigorta.com.tr'),
    ]);
    expect(applied.match(company('x1', 'Kartal Ödeme (Türkiye / İstanbul)', 'kartalodeme.com.tr'))?.id).toBe('a1');
    expect(applied.match(company('x2', 'Yosun Istanbul (Yosun Engage)'))?.id).toBe('a2');
    expect(applied.match(company('x3', 'Yosun Türkiye (Yosun İstanbul)', 'yosun.com.tr'))?.id).toBe('a2');
    expect(applied.match(company('x4', 'Pırıl Türkiye (Pırıl Teknoloji Ticaret Limited Şirketi)', 'pirilteknoloji.com.tr'))?.id).toBe('a3');
    expect(applied.match(company('x5', 'DALGA (The Brandtech Group) – İstanbul', 'dalgaagency.com'))?.id).toBe('a4');
    expect(applied.match(company('a5', 'adı değişmiş'))?.id).toBe('a5');
    expect(applied.match(company('y1', 'Fener Games', 'fener.gs'))).toBeNull();
    expect(applied.match(company('y2', 'Unda Studio', 'unda.studio'))).toBeNull();
    expect(applied.match(company('y3', 'Kartal Lojistik', 'kartallojistik.com'))).toBeNull();
    expect(applied.size).toBe(6);
  });

  it('anahtarlar ad ve alan adı köklerini birlikte taşır', () => {
    expect(identityKeysOf({ name: 'Kartal Ödeme', canonicalDomain: 'kartalodeme.com', website: 'https://www.kartalodeme.com.tr' })).toEqual(['n:kartal odeme', 'd:kartalodeme']);
  });
});

describe('başvurulan firmanın yeni ilanı', () => {
  const now = new Date('2026-10-22T09:00:00Z');

  it('yayın tarihi son 30 gün içindeyse ya da bilinmiyorsa güncel sayılır', () => {
    expect(isFreshListing([], now)).toBe(true);
    expect(isFreshListing([null, undefined], now)).toBe(true);
    expect(isFreshListing([new Date('2026-10-20T00:00:00Z')], now)).toBe(true);
    expect(isFreshListing([new Date('2026-08-01T00:00:00Z')], now)).toBe(false);
    expect(isFreshListing([new Date('2026-08-01T00:00:00Z'), new Date('2026-10-10T00:00:00Z')], now)).toBe(true);
  });

  it('bildirim metni başvuru tarihini ve başka adla açılmış kaydı yazar', () => {
    const same = appliedCompanyJobNotice({ jobTitle: 'Art Director', companyName: 'Kabuk Ajans', appliedName: 'Kabuk Ajans', appliedAt: new Date('2026-10-01T10:00:00Z') });
    expect(same.title).toBe('Başvurduğun firmada yeni ilan: Art Director — Kabuk Ajans');
    expect(same.body).toContain('01.10.2026 tarihinde bu firmaya başvurmuştun');
    const twin = appliedCompanyJobNotice({ jobTitle: 'Art Director', companyName: 'Kabuk Türkiye', appliedName: 'Kabuk Ajans', appliedAt: new Date('2026-10-01T10:00:00Z') });
    expect(twin.body).toContain('bu firmaya (Kabuk Ajans) başvurmuştun');
  });
});
