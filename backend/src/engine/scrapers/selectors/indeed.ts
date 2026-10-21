/**
 * Indeed Türkiye arama sonuç sayfası. Yapı 20 Ekim 2026'da tarayıcıda açılan gerçek sayfadan
 * (/jobs?q=flutter&l=İstanbul) okundu: ilanlar hem gömülü JSON'da (mosaic-provider-jobcards) hem kartlarda bulunur.
 * Aynı gün sunucudan yapılan istek Cloudflare doğrulama sayfasıyla (403, "Security Check") karşılandı.
 *
 * robots.txt: /jobs?q=…&l=… taranabilir; sayfalama yalnızca "&start=10&" … "&start=90&" biçiminde izinli (start
 * parametresinden sonra başka bir parametre gelmeli); /viewjob (ilan ayrıntısı) yasak — ayrıntı sayfası okunmaz.
 */
export const INDEED = {
  origin: 'https://tr.indeed.com',
  searchPath: '/jobs',
  pageSize: 10,
  viewJobPath: (jobKey: string) => `/viewjob?jk=${encodeURIComponent(jobKey)}`,
  embeddedData: 'window.mosaic.providerData["mosaic-provider-jobcards"]=',
  selectors: {
    card: 'a[data-jk]',
    title: 'span[id^="jobTitle-"]',
    cardRoot: 'li',
    company: '[data-testid="company-name"]',
    location: '[data-testid="text-location"]',
  },
  blockMarkers: ['cf_chl_opt', 'Additional Verification Required', '<title>Security Check', '<title>Just a moment'],
} as const;
