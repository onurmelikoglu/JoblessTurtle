import { RawCard } from '../../../domain/scraped-jobs';
import { ISINOLSUN } from '../selectors/isinolsun';
import { ParsedPage } from '../types';
import { assertReadable, readBrowserPayload } from './browser-payload';
import { isinolsunLocation } from './isinolsun.parser';

/**
 * İşin Olsun sonuç sayfasını kullanıcının tarayıcısında okuyan betik. Kartlar yapıdan okunur (bağlantı içindeki h3,
 * title öznitelikli firma ve adres); kartlar: [bağlantı, başlık, firma, adres, çalışma türü]. Sonraki sayfa: "pn"
 * parametresi bir fazla olan bağlantı ya da <link rel="next">.
 */
export const ISINOLSUN_BROWSER_SCRIPT = `(() => {
  const S = ${JSON.stringify(ISINOLSUN.selectors)};
  const MARKERS = ${JSON.stringify(ISINOLSUN.blockMarkers)};
  const PAGE = ${JSON.stringify(ISINOLSUN.pageQuery)};
  const html = document.documentElement.outerHTML;
  const marker = MARKERS.find((m) => html.includes(m)) || null;
  const clean = (value) => (value || '').replace(/\\s+/g, ' ').trim() || null;
  const cards = [...document.querySelectorAll(S.link)].filter((a) => a.querySelector(S.title)).map((a) => {
    const company = a.querySelector(S.company);
    const place = a.querySelector(S.location);
    const tag = [...a.querySelectorAll(S.tag)].map((s) => clean(s.textContent)).find((t) => t && /zaman|part|dönem|sezon|stajyer/i.test(t)) || null;
    return [a.getAttribute('href'), clean(a.querySelector(S.title).textContent), company ? clean(company.getAttribute('title') || company.textContent) : null, place ? clean(place.getAttribute('title') || place.textContent) : null, tag];
  });
  const current = Number(new URLSearchParams(location.search).get(PAGE)) || 1;
  const nextLink = document.querySelector('link[rel="next"]');
  const next = (!!nextLink && Number(new URL(nextLink.href).searchParams.get(PAGE)) === current + 1) || [...document.querySelectorAll('a[href]')].some((a) => {
    try {
      return Number(new URL(a.getAttribute('href'), location.origin).searchParams.get(PAGE)) === current + 1;
    } catch (e) {
      return false;
    }
  });
  return 'JT_PAGE ' + JSON.stringify({ v: 1, source: 'isinolsun', url: location.href, marker, root: !!document.querySelector('form[action$="${ISINOLSUN.searchPath}"]'), next, cards });
})()`;

const str = (value: unknown) => (typeof value === 'string' && value.trim() ? value : null);

export function isinolsunFromBrowser(payload: unknown, url: string): ParsedPage {
  const data = readBrowserPayload(payload, 'isinolsun', url);
  assertReadable(data, url, `İlan kartı bulunamadı (${ISINOLSUN.selectors.link} içinde ${ISINOLSUN.selectors.title}); sayfa düzeni değişmiş olabilir`);
  const cards: RawCard[] = data.cards.map((row) => {
    const [href, title, company, address, workType] = row.map(str);
    return {
      platformId: href?.split(/[?#]/)[0].match(ISINOLSUN.listingId)?.[1]?.toUpperCase() ?? null,
      title,
      company,
      location: isinolsunLocation(address),
      url: href,
      employmentType: workType,
    };
  });
  return { cards, hasNextPage: data.next };
}
