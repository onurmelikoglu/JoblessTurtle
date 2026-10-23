/**
 * Yenibiriş arama sonuç sayfası (sunucuda üretilen HTML, üyeliksiz). Yapı 23 Ekim 2026'da tarayıcıda açılan gerçek
 * sayfalardan okundu (/is-ilanlari/istanbul, ?q=…, &sayfa=2; sayfa başına 25 kart).
 *
 * Sunucudan erişim kapalı: aynı gün robots.txt dahil her istek Cloudflare "Attention Required" sayfasıyla 403 döndü.
 * Bu yüzden sunucu taraması yoktur (serverScraping: false); ilanlar yalnızca kullanıcının tarayıcısında açtığı sayfadan
 * eklentiyle alınır. Çok şehirli arama sitenin kendi şehir kimlikleriyle (form alanı) yapılıyor, adres biçimi
 * doğrulanmadı: tarayıcı aramaları pozisyon × şehir (/is-ilanlari/<şehir>?q=…).
 */
export const YENIBIRIS = {
  origin: 'https://www.yenibiris.com',
  cityPath: (citySlug: string) => `/is-ilanlari/${citySlug}`,
  searchPath: '/is-ilanlari',
  keywordQuery: 'q',
  pageQuery: 'sayfa',
  searchPagePath: /^\/is-ilanlari(?:\/([a-z0-9-]+))?\/?$/,
  listingId: /\/is-ilani\/[^/]+\/(\d+)\/?$/,
  selectors: {
    card: '.listViewRows',
    title: 'a.gtmTitle',
    company: '.gtmCompanyName',
    location: '.gtmLocation',
    date: '.gtmDate > div[title]',
    tag: '.listJobTag',
  },
  blockMarkers: ['cf_chl_opt', '<title>Just a moment', 'Attention Required! | Cloudflare', '<title>Attention Required'],
} as const;
