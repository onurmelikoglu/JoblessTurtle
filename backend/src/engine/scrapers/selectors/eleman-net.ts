/**
 * Eleman.net arama sonuç sayfası (sunucuda üretilen HTML, üyeliksiz). Yapı 23 Ekim 2026'da tarayıcıda normal kullanıcı
 * gibi açılan gerçek sayfalardan okundu (/is-ilanlari/istanbul, ?sy=2, ?aranan=…&sehir=…). Aynı gün sunucudan dürüst
 * kullanıcı ajanıyla yapılan istekler 200 döndü (sayfa başına 30 kart).
 *
 * robots.txt: şehir ve pozisyon sayfaları, "sy" sayfalaması ve "aranan" araması serbest; "?t=", "?tip=", "?ilan_id=",
 * /is_ilanlari.php, *.html yasak. Kartta firma ve konum aynı alt başlıkta <br> ile ayrılır; tarih ve çalışma türü yok.
 * Aramadaki "sehir" parametresi süzmüyor (23 Ekim 2026: "aranan=muhasebe&sehir=Kocaeli" ülke geneli 37 ilan getirdi);
 * şehir yoluna eklenen anahtar kelime bölüm sayfasına ("/is-ilanlari/kocaeli/muhasebe") ya da düz şehir sayfasına
 * yönlendiriliyor. Tarayıcı aramaları bu yüzden pozisyon başına ve şehirsiz.
 */
export const ELEMAN_NET = {
  origin: 'https://www.eleman.net',
  cityPath: (citySlug: string) => `/is-ilanlari/${citySlug}`,
  searchPath: '/is-ilanlari',
  keywordQuery: 'aranan',
  cityQuery: 'sehir',
  pageQuery: 'sy',
  searchPagePath: /^\/is-ilanlari(?:\/([a-z0-9-]+))?\/?$/,
  listingId: /-i(\d+)\/?$/,
  selectors: {
    card: '.ilan_listeleme_bol',
    link: 'a[href*="/is-ilani/"]',
    title: 'h3.c-showcase-box__title',
    titleNoise: '.ilantik-grubu',
    subtitle: '.c-showcase-box__subtitle',
    text: '.c-showcase-box__text',
  },
  blockMarkers: ['cf_chl_opt', '<title>Just a moment', 'Attention Required! | Cloudflare', 'px-captcha', 'Access to this page has been denied'],
} as const;
