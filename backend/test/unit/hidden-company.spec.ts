import { isHiddenCompany, visibleCompanyName } from '../../src/domain/hidden-company';

describe('adı gizli firma', () => {
  it('ilan sitelerindeki gizli firma adları tanınır', () => {
    for (const name of ['Gizli Firma', 'GİZLİ ŞİRKET', 'Firma Adı Gizli', 'FİRMA ADI GİZLİ', 'Firma Bilgisi Gizli', 'Gizli Firma (Software Development, 1.001–5.000 çalışan)', 'Sektöründe Lider Firma (gizli firma)', 'Confidential', 'Confidential Company', 'Gizli', '']) {
      expect(isHiddenCompany(name)).toBe(true);
    }
  });

  it('gerçek ad da yazıyorsa o kullanılır; gizli sözcüğü geçen gerçek firmalar etkilenmez', () => {
    expect(visibleCompanyName('Gizli Firma / KARTAL ÇELİK GAYRİMENKUL YAPI SANAYİ TİCARET AN')).toBe('KARTAL ÇELİK GAYRİMENKUL YAPI SANAYİ TİCARET AN');
    expect(visibleCompanyName('Gizlice Yazılım')).toBe('Gizlice Yazılım');
    expect(visibleCompanyName('Gizli Bahçe Kafe')).toBe('Gizli Bahçe Kafe');
    expect(visibleCompanyName('DURU TAŞ LTD ŞTİ')).toBe('DURU TAŞ LTD ŞTİ');
  });
});
