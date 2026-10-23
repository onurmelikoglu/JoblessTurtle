/**
 * İşin Olsun arama sonuç sayfası (Next.js; üyeliksiz). Yapı 23 Ekim 2026'da tarayıcıda açılan gerçek sayfalardan okundu
 * (/is-ilanlari/istanbul, ?pn=2, /is-ilanlari?kw=…&lc=…): ilanlar sayfaya gömülü __NEXT_DATA__ içinde
 * (props.pageProps.jobs, sayfa başına 40-42; pageNumber/pageCount) ve kartlarda. Sitenin kendi sayfa geçişlerinde
 * __NEXT_DATA__ yenilenmediği için tarayıcıda kartlar okunur; kart sınıf adları üretilmiş (karışık) olduğundan
 * yalnızca yapıya (bağlantı, h3, title öznitelikleri) güvenilir. Aynı gün sunucudan istekler 200 döndü.
 *
 * robots.txt: "Allow: /". Kart ve gömülü veride tarih yalnızca kısaltma olarak var ("2s", "15+ gün").
 * Birleşik arama yok (23 Ekim 2026'da ölçüldü): "lc=Kocaeli,İzmir" ve "kw=garson,barista" 0 sonuç verdi; "lc" ve "kw"
 * tek değer alır, tarayıcı aramaları pozisyon × şehir.
 */
export const ISINOLSUN = {
  origin: 'https://isinolsun.com',
  cityPath: (citySlug: string) => `/is-ilanlari/${citySlug}`,
  searchPath: '/is-ilanlari',
  keywordQuery: 'kw',
  cityQuery: 'lc',
  pageQuery: 'pn',
  searchPagePath: /^\/is-ilanlari(?:\/([a-z0-9-]+))?\/?$/,
  listingId: /([0-9A-F]{32})\/?$/i,
  embeddedData: '__NEXT_DATA__',
  selectors: {
    link: 'a[href*="/is-ilani/"]',
    title: 'h3',
    company: 'p[title]',
    location: 'div[title]',
    tag: 'span',
  },
  /** Gömülü verideki çalışma türü kodu; yalnızca gerçek sayfada kartla eşleştirilerek doğrulananlar. */
  workTypes: { 1: 'Tam zamanlı' } as Record<number, string>,
  blockMarkers: ['px-captcha', 'Access to this page has been denied', '<title>Just a moment', 'cf_chl_opt'],
} as const;
