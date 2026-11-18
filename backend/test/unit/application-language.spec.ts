import { applicationLanguageOf, englishCvMissing, textLanguage } from '../../src/domain/application-language';

const englishPosting =
  'We are looking for a Senior Mobile Developer to join our team. You will build and maintain our apps, work with product and design, and have strong experience with Flutter. Requirements: 5+ years of experience, ability to work in a fast paced team, knowledge of CI and testing.';
const turkishPosting =
  'Ekibimize katılacak, Flutter konusunda deneyimli Kıdemli Mobil Geliştirici arıyoruz. Mobil uygulamalarımızın geliştirilmesi ve bakımı sizin sorumluluğunuzda olacak. Aranan nitelikler: en az 5 yıl deneyim, takım çalışmasına yatkın, üniversitelerin ilgili bölümlerinden mezun, test ve CI bilgisi olan.';

describe('başvuru dili', () => {
  it('metnin dilini tanır, kısa metinde karar vermez', () => {
    expect(textLanguage(englishPosting)).toBe('en');
    expect(textLanguage(turkishPosting)).toBe('tr');
    expect(textLanguage('Flutter Developer')).toBeNull();
  });

  it('firma için seçilen dil her şeyin önündedir', () => {
    expect(applicationLanguageOf({ companyChoice: 'tr', jobDescription: englishPosting })).toEqual({ language: 'tr', reason: 'company_choice' });
    expect(applicationLanguageOf({ companyChoice: 'en', officeTexts: ['Kadıköy, İstanbul'] })).toEqual({ language: 'en', reason: 'company_choice' });
  });

  it('yurt dışı ilanı ve İngilizce ilan metni İngilizce yazılır', () => {
    expect(applicationLanguageOf({ jobLocation: 'Berlin, Germany', officeTexts: ['Maslak, İstanbul'] })).toEqual({ language: 'en', reason: 'abroad_listing' });
    expect(applicationLanguageOf({ jobDescription: englishPosting, officeTexts: ['Maslak, İstanbul'] })).toEqual({ language: 'en', reason: 'listing_text' });
    expect(applicationLanguageOf({ jobDescription: turkishPosting })).toEqual({ language: 'tr', reason: 'listing_text' });
  });

  it('ilan yoksa firmanın Türkiye bağına bakılır', () => {
    expect(applicationLanguageOf({ domain: 'acme.com', officeTexts: ['Levent, İstanbul'] })).toEqual({ language: 'tr', reason: 'turkish_company' });
    expect(applicationLanguageOf({ domain: 'firma.com.tr' })).toEqual({ language: 'tr', reason: 'turkish_company' });
    expect(applicationLanguageOf({ domain: 'acme.io', officeTexts: ['London, United Kingdom', 'Amsterdam'] })).toEqual({ language: 'en', reason: 'foreign_company' });
    expect(applicationLanguageOf({ domain: 'acme.io', siteLanguage: 'en-US' })).toEqual({ language: 'en', reason: 'foreign_company' });
    expect(applicationLanguageOf({ domain: 'acme.com' })).toEqual({ language: 'tr', reason: 'default' });
  });

  it('İngilizce yazıda İngilizce CV yoksa eksik sayılır', () => {
    expect(englishCvMissing('en', [{ type: 'cv', language: 'tr' }])).toBe(true);
    expect(englishCvMissing('en', [])).toBe(true);
    expect(englishCvMissing('en', [{ type: 'cv', language: 'en' }, { type: 'portfolio', language: 'tr' }])).toBe(false);
    expect(englishCvMissing('tr', [{ type: 'cv', language: 'tr' }])).toBe(false);
  });
});
