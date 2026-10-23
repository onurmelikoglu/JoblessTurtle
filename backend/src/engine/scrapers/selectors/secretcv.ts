/**
 * Secretcv arama sonuç sayfası (sunucuda üretilen HTML, üyeliksiz). Yapı 23 Ekim 2026'da tarayıcıda açılan gerçek
 * sayfalardan okundu (/is-ilanlari/istanbul-is-ilanlari, /is-ilanlari/ara-is-ilanlari?k=…; sayfa başına 20-22 kart).
 *
 * robots.txt sayfalamayı ("*\/?sf=*") ve aramayı ("/is-ilanlari/ara", "*ara?k=*") yasaklıyor: sunucu taraması
 * yalnızca şehir sayfasının ilk sayfasını okur, anahtar kelimeler yerelde süzülür. Kullanıcının kendi tarayıcısında
 * açtığı arama ve sonraki sayfalar eklentiyle aktarılabilir. Arama adresinde şehir süzgeci yok (şehir parametresi
 * denemesi hata sayfası verdi): tarayıcı aramaları pozisyon başına, ülke geneli.
 */
export const SECRETCV = {
  origin: 'https://www.secretcv.com',
  cityPath: (citySlug: string) => `/is-ilanlari/${citySlug}-is-ilanlari`,
  keywordSearchPath: '/is-ilanlari/ara-is-ilanlari',
  keywordQuery: 'k',
  pageQuery: 'sf',
  searchPagePath: /^\/is-ilanlari(?:\/([a-z0-9-]+))?\/?$/,
  listingId: /-(\d+)\/?$/,
  pageSuffix: '-is-ilanlari',
  selectors: {
    card: '.cv-job-box.job-list',
    title: 'a.title',
    company: '.company',
    location: '.city > span',
    date: '.city small',
  },
  datePrefix: /^\s*İlan Tarihi:\s*/i,
  blockMarkers: ['cf_chl_opt', '<title>Just a moment', 'Attention Required! | Cloudflare', 'px-captcha', 'Access to this page has been denied'],
} as const;
