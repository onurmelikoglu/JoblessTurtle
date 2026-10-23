import { RawCard } from '../../../domain/scraped-jobs';
import { YENIBIRIS } from '../selectors/yenibiris';
import { ParsedPage } from '../types';
import { assertReadable, readBrowserPayload } from './browser-payload';
import { yenibirisTags } from './yenibiris.parser';

/**
 * Yenibiriş sonuç sayfasını kullanıcının tarayıcısında okuyan betik. Kartlar: [bağlantı, başlık, firma, konum, tarih,
 * etiketler ("|" ile)]. Sonraki sayfa: "sayfa" parametresi bir fazla olan bağlantı.
 */
export const YENIBIRIS_BROWSER_SCRIPT = `(() => {
  const S = ${JSON.stringify(YENIBIRIS.selectors)};
  const MARKERS = ${JSON.stringify(YENIBIRIS.blockMarkers)};
  const PAGE = ${JSON.stringify(YENIBIRIS.pageQuery)};
  const html = document.documentElement.outerHTML;
  const marker = MARKERS.find((m) => html.includes(m)) || null;
  const text = (el) => (el ? el.textContent.replace(/\\s+/g, ' ').trim() : '') || null;
  const cards = [...document.querySelectorAll(S.card)].filter((el) => el.querySelector(S.title)).map((el) => {
    const link = el.querySelector(S.title);
    const company = el.querySelector(S.company);
    const tags = [...el.querySelectorAll(S.tag)].map(text).filter(Boolean).join('|') || null;
    return [link.getAttribute('href'), text(link), company ? (company.getAttribute('title') || '').trim() || text(company) : null, text(el.querySelector(S.location)), text(el.querySelector(S.date)), tags];
  });
  const current = Number(new URLSearchParams(location.search).get(PAGE)) || 1;
  const next = [...document.querySelectorAll('a[href]')].some((a) => {
    try {
      return Number(new URL(a.getAttribute('href'), location.origin).searchParams.get(PAGE)) === current + 1;
    } catch (e) {
      return false;
    }
  });
  return 'JT_PAGE ' + JSON.stringify({ v: 1, source: 'yenibiris', url: location.href, marker, root: !!document.querySelector('form[action="${YENIBIRIS.searchPath}"]'), next, cards });
})()`;

const str = (value: unknown) => (typeof value === 'string' && value.trim() ? value : null);

export function yenibirisFromBrowser(payload: unknown, url: string): ParsedPage {
  const data = readBrowserPayload(payload, 'yenibiris', url);
  assertReadable(data, url, `İlan listesi bulunamadı (${YENIBIRIS.selectors.card}); sayfa düzeni değişmiş olabilir`);
  const cards: RawCard[] = data.cards.map((row) => {
    const [href, title, company, location, date, tags] = row.map(str);
    return {
      platformId: href?.split(/[?#]/)[0].match(YENIBIRIS.listingId)?.[1] ?? null,
      title,
      company,
      location,
      url: href,
      publishedText: date,
      ...yenibirisTags(tags ? tags.split('|') : []),
    };
  });
  return { cards, hasNextPage: data.next };
}
