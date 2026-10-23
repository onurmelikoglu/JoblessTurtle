/**
 * Kariyer.net arama sonuç sayfası (sunucuda üretilen HTML). Değerler 20 Ekim 2026'da gerçek sayfadan
 * (/is-ilanlari/istanbul, /is-ilanlari/istanbul-2, /is-ilanlari/izmir) okundu. Site düzeni değişirse yalnızca bu dosya
 * güncellenir; ayrıştırıcı bir kart bile bulamazsa çalışma "selector" hatasıyla kaydedilir.
 *
 * Sayfalama yol ekidir: /is-ilanlari/istanbul, /is-ilanlari/istanbul-2 …
 * Anahtar kelimeli arama (?kw=…) ve pozisyon adresleri aynı gün PerimeterX doğrulamasına takıldı; bu yüzden varsayılan
 * anahtar kelime kipi "local_filter"dır (şehir sayfası taranır, ilanlar yerelde süzülür).
 */
export const KARIYER_NET = {
  origin: 'https://www.kariyer.net',
  cityPath: (citySlug: string, page: number) => `/is-ilanlari/${citySlug}${page > 1 ? `-${page}` : ''}`,
  keywordQuery: 'kw',
  /**
   * Eklentinin aktardığı arama sayfaları: şehir, ilçe ("istanbul+avrupa-sisli") ya da pozisyon eki, isteğe bağlı sayfa
   * numarası. İlçe biçimi 23 Ekim 2026'da gerçek sayfadaki bağlantılardan okundu.
   */
  searchPagePath: /^\/is-ilanlari\/([a-z0-9+-]+?)(?:-\d+)?\/?$/,
  listingPath: /^\/is-ilani\/.+-(\d+)\/?$/,
  selectors: {
    listRoot: '[data-test="list-items"]',
    card: '[data-test="ad-card"]',
    link: 'a[data-test="ad-card-item"]',
    title: '[data-test="ad-card-title"]',
    company: '[data-test="subtitle"]',
    location: '[data-test="location"]',
    workModel: '[data-test="work-model"]',
    date: '[data-test="ad-date"]',
  },
  attributes: {
    city: 'cityname',
    workType: 'worktypetext',
    workModel: 'workmodeltext',
    dateStatus: 'jobdatestatus',
    position: 'positionname',
  },
  updatedDateStatus: 'Updated',
  blockMarkers: ['px-captcha', 'window._pxAppId', 'Access to this page has been denied'],
} as const;
