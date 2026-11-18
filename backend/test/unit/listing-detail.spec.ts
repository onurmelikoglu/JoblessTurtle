import { extractListingDescription, parseSmartRecruitersDetail, smartRecruitersDetailUrl } from '../../src/engine/connectors/listing-detail';

const page = (body: string, head = '') => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

describe('ilan sayfasından ilan metni', () => {
  it('isinolsun: metin Next.js sayfa verisindeki ilandan okunur, benzer ilanlar karışmaz', () => {
    const data = {
      props: {
        pageProps: {
          job: { description: '<p>E ticaret ve sosyal hesapları yönetecek profesyonel ekip arkadaşı aranmaktadır. </p>' },
          suggestions: [{ description: '<p>Cafe servis elemanı arıyoruz, barista deneyimi tercih sebebidir ve uzun bir metin.</p>' }],
        },
      },
    };
    const html = page('<h1>İlan</h1>', `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script>`);
    expect(extractListingDescription(html, 'https://isinolsun.com/is-ilani/x-0ioj1')).toBe('E ticaret ve sosyal hesapları yönetecek profesyonel ekip arkadaşı aranmaktadır.');
  });

  it('JobPosting JSON-LD varsa açıklaması alınır', () => {
    const ld = { '@context': 'https://schema.org', '@type': 'JobPosting', title: 'Sosyal Medya Uzmanı', description: '<p>Sosyal medya hesaplarını yönetecek</p><ul><li>Meta Ads</li></ul>' };
    const html = page('', `<script type="application/ld+json">${JSON.stringify(ld)}</script>`);
    const text = extractListingDescription(html, 'https://www.eleman.net/is-ilani/x-i1');
    expect(text).toContain('Sosyal medya hesaplarını yönetecek');
    expect(text).toContain('Meta Ads');
  });

  it('Kariyer.net: ilan metni alanından okunur, sayfanın geri kalanı alınmaz', () => {
    const html = page('<div class="job-detail-container-description"><p>Moda sektöründe Sosyal Medya Uzmanı arıyoruz.</p><h3>Genel Nitelikler</h3><ul><li>En az 5 yıl deneyim</li></ul></div><div class="card-description">Maaş beklentisi aralığı</div>');
    const text = extractListingDescription(html, 'https://www.kariyer.net/is-ilani/ornek-moda-sosyal-medya-uzmani-1000001');
    expect(text).toContain('En az 5 yıl deneyim');
    expect(text).not.toContain('Maaş');
  });

  it('bilinmeyen sitede metin alanı tahmin edilmez', () => {
    expect(extractListingDescription(page('<div class="job-detail-container-description">Metin</div>'), 'https://ornek.com/ilan/1')).toBeNull();
  });

  it('SmartRecruiters sayfası detay API adresine çevrilir ve bölümleri birleştirilir', () => {
    expect(smartRecruitersDetailUrl('https://jobs.smartrecruiters.com/OrnekOtel/100000000000001')).toBe('https://api.smartrecruiters.com/v1/companies/OrnekOtel/postings/100000000000001');
    expect(smartRecruitersDetailUrl('https://isinolsun.com/is-ilani/x')).toBeNull();
    const text = parseSmartRecruitersDetail({
      jobAd: {
        sections: {
          companyDescription: { title: 'Şirket', text: '<p>Otel zinciri</p>' },
          jobDescription: { title: 'Job Description', text: '<p>Manage&#xa0;social&#160;media</p>' },
          qualifications: { title: 'Qualifications', text: '<ul><li>3 years experience</li></ul>' },
        },
      },
    });
    expect(text).toContain('Manage social media');
    expect(text).toContain('3 years experience');
    expect(text).not.toContain('Otel zinciri');
    expect(parseSmartRecruitersDetail({})).toBeNull();
  });
});
