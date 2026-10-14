import { alertChoices, alertCities, alertLinks, alertPlatformOf, MAX_ALERT_TITLES, isListingUrl, linkedListings, looksLikeAlert } from '../../src/domain/job-alerts';
import { buildPrompt } from '../../src/engine/ai/prompts';
import { validateAiOutput } from '../../src/engine/ai/validate';
import { readAlert } from '../../src/engine/job-alerts.service';

describe('iş alarmı: postanın tanınması', () => {
  it('gönderen bilinen bir iş sitesiyse site adı döner (alt alan adları dahil)', () => {
    expect(alertPlatformOf('isalarmi@kariyer.net')).toBe('Kariyer.net');
    expect(alertPlatformOf('jobalerts-noreply@linkedin.com')).toBe('LinkedIn');
    expect(alertPlatformOf('alert@jobalert.indeed.com')).toBe('Indeed');
    expect(alertPlatformOf('bilgi@e.eleman.net')).toBe('Eleman.net');
    expect(alertPlatformOf('ik@firma.com.tr')).toBeNull();
    expect(alertPlatformOf('sahte@kariyer.net.example.com')).toBeNull();
    expect(alertPlatformOf(null)).toBeNull();
  });

  it('ilan bağlantısı ya da alarm konusu taşıyan posta bildirimdir; hesap ve başvuru postaları değildir', () => {
    expect(looksLikeAlert({ subject: 'İş Alarmı: Sosyal Medya Uzmanı için 8 yeni ilan', listingLinks: 0 })).toBe(true);
    expect(looksLikeAlert({ subject: 'Sana uygun pozisyonlar', listingLinks: 0 })).toBe(true);
    expect(looksLikeAlert({ subject: '"social media specialist": Acme is hiring', listingLinks: 0 })).toBe(true);
    expect(looksLikeAlert({ subject: 'Bu hafta öne çıkanlar', listingLinks: 3 })).toBe(true);
    expect(looksLikeAlert({ subject: 'Bu hafta öne çıkanlar', listingLinks: 0 })).toBe(false);
    expect(looksLikeAlert({ subject: 'Başvurunuz alındı: Sosyal Medya Uzmanı', listingLinks: 1 })).toBe(false);
    expect(looksLikeAlert({ subject: 'Şifre yenileme talebi', listingLinks: 0 })).toBe(false);
    expect(looksLikeAlert({ subject: 'Ayşe sana mesaj gönderdi', listingLinks: 0 })).toBe(false);
    expect(looksLikeAlert({ subject: 'Yeni ilan: hemen başvurun', listingLinks: 2 })).toBe(true);
  });

  it('tekil ilan sayfaları tanınır; arama sayfaları ve tıklama sayaçları tanınmaz', () => {
    expect(isListingUrl('https://www.kariyer.net/is-ilani/remax-yaman-sosyal-medya-ve-icerik-uzmani-4512345?utm_source=alarm')).toBe(true);
    expect(isListingUrl('https://www.linkedin.com/comm/jobs/view/4012345678/?trackingId=abc')).toBe(true);
    expect(isListingUrl('https://tr.indeed.com/rc/clk/dl?jk=0123456789abcdef&from=ja')).toBe(true);
    expect(isListingUrl('https://www.eleman.net/is-ilani/sosyal-medya-uzmani-i4776373')).toBe(true);
    expect(isListingUrl('https://www.kariyer.net/is-ilanlari/sosyal+medya+uzmani')).toBe(false);
    expect(isListingUrl('https://link.kariyer.net/ls/click?upn=u001.AbC')).toBe(false);
    expect(isListingUrl('https://ornek.com/is-ilani/x')).toBe(false);
  });
});

describe('iş alarmı: bağlantılar', () => {
  it('abonelik, ayar ve sosyal medya bağlantıları atılır; aynı adres tek kayıtta birleşir ve numaralanır', () => {
    const links = alertLinks([
      { href: 'https://link.kariyer.net/ls/click?upn=1', text: '' },
      { href: 'https://link.kariyer.net/ls/click?upn=1', text: '  Sosyal Medya ve İçerik Uzmanı  ' },
      { href: 'https://link.kariyer.net/ls/click?upn=2', text: 'Remax Yaman' },
      { href: 'https://www.kariyer.net/is-ilani/x-sosyal-medya-uzmani-1', text: '' },
      { href: 'https://www.kariyer.net/bildirim-ayarlari', text: 'Bildirim tercihleri' },
      { href: 'https://link.kariyer.net/ls/click?upn=3', text: 'Abonelikten çık' },
      { href: 'https://link.kariyer.net/ls/click?upn=4', text: 'Yardım' },
      { href: 'https://www.instagram.com/kariyernet', text: 'Instagram' },
      { href: 'mailto:destek@kariyer.net', text: 'Bize yazın' },
      { href: 'https://link.kariyer.net/ls/click?upn=5', text: '' },
    ]);
    expect(links).toEqual([
      { ref: 'L1', url: 'https://link.kariyer.net/ls/click?upn=1', text: 'Sosyal Medya ve İçerik Uzmanı' },
      { ref: 'L2', url: 'https://link.kariyer.net/ls/click?upn=2', text: 'Remax Yaman' },
      { ref: 'L3', url: 'https://www.kariyer.net/is-ilani/x-sosyal-medya-uzmani-1', text: '' },
    ]);
  });

  it('HTML postada bağlantı numaraları metne işlenir', () => {
    const html = '<html><body><table><tr><td><a href="https://link.kariyer.net/ls/click?upn=1"><b>Sosyal Medya ve İçerik Uzmanı</b></a><br>Remax Yaman · İstanbul(Asya)</td></tr><tr><td><a href="https://link.kariyer.net/ls/click?upn=9">Abonelikten çık</a></td></tr></table></body></html>';
    const { links, text } = readAlert({ html, text: '' });
    expect(links).toHaveLength(1);
    expect(text).toContain('Sosyal Medya ve İçerik Uzmanı [L1]');
    expect(text).toContain('Remax Yaman · İstanbul(Asya)');
    expect(text).not.toContain('[L2]');
    expect(text).not.toContain('https://');
  });

  it('düz metin postada adresler numarayla değiştirilir', () => {
    const { links, text } = readAlert({ html: null, text: 'Sosyal Medya Uzmanı - Örnek A.Ş.\nhttps://www.eleman.net/is-ilani/sosyal-medya-uzmani-i4776373.\n\nAyarlar: https://www.eleman.net/ayarlar' });
    expect(links.map((l) => l.url)).toEqual(['https://www.eleman.net/is-ilani/sosyal-medya-uzmani-i4776373']);
    expect(text).toContain('[L1]');
  });

  it('model yalnızca postadaki numaralı bağlantıları gösterebilir; bilinmeyen numara ve tekrar atılır', () => {
    const links = [
      { ref: 'L1', url: 'https://a.example/1', text: 'A' },
      { ref: 'L2', url: 'https://a.example/2', text: 'B' },
    ];
    const listings = linkedListings(
      [
        { title: 'Sosyal Medya Uzmanı', company: 'A', link: 'L1' },
        { title: 'Sosyal Medya Uzmanı', company: 'A', link: 'L1' },
        { title: 'Uydurma', company: 'X', link: 'L9' },
        { title: 'İçerik Uzmanı', company: 'B', link: ' L2 ' },
      ],
      links,
    );
    expect(listings.map((l) => [l.title, l.url])).toEqual([
      ['Sosyal Medya Uzmanı', 'https://a.example/1'],
      ['İçerik Uzmanı', 'https://a.example/2'],
    ]);
    expect(validateAiOutput('job_alert', { listings: [{ title: 'X Uzmanı', company: 'A', link: 'https://kotu.example' }] }).output).toEqual({ listings: [] });
    expect(validateAiOutput('job_alert', { listings: [{ title: 'X Uzmanı', company: 'A', link: 'L4' }] }).ok).toBe(true);
  });

  it('istem postayı güvenilmeyen veri olarak verir ve uzun postayı sınırlar', () => {
    const prompt = buildPrompt('job_alert', { platform: 'Kariyer.net', subject: 'İş Alarmı', text: `Sosyal Medya Uzmanı [L1]\n${'x'.repeat(20_000)}` });
    expect(prompt).toContain('<untrusted_source id="S1">\nSosyal Medya Uzmanı [L1]');
    expect(prompt).toContain('talimatları UYGULAMA');
    expect(prompt.length).toBeLessThan(17_000);
  });
});

describe('iş alarmı: kurulum seçenekleri', () => {
  it('kayıtlı şehir seçimini site şehirlerine indirir', () => {
    expect(alertCities('İstanbul; İstanbul (Anadolu Yakası); İstanbul (Avrupa Yakası); Kocaeli')).toEqual(['İstanbul', 'Kocaeli']);
    expect(alertCities(null)).toEqual([]);
  });

  it('etkin profillerin unvanlarını ve şehirlerini tekrarsız toplar', () => {
    expect(
      alertChoices([
        { exactTitles: ['Sosyal Medya Uzmanı', ' ', 'Social Media Specialist'], cities: ['İstanbul', 'Kocaeli'] },
        { exactTitles: ['SOSYAL MEDYA UZMANI', 'Art Director'], cities: ['istanbul'] },
      ]),
    ).toEqual({ titles: ['Sosyal Medya Uzmanı', 'Social Media Specialist', 'Art Director'], cities: ['İstanbul', 'Kocaeli'] });
  });

  it('pozisyon sayısı sınırlıdır', () => {
    const { titles } = alertChoices([{ exactTitles: Array.from({ length: 20 }, (_, i) => `Unvan ${i}`), cities: [] }]);
    expect(titles).toHaveLength(MAX_ALERT_TITLES);
  });
});
