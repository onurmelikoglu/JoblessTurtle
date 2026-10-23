import { RawCard } from '../../../domain/scraped-jobs';
import { SECRETCV } from '../selectors/secretcv';
import { ParsedPage } from '../types';
import { assertReadable, readBrowserPayload } from './browser-payload';
import { secretcvDate } from './secretcv.parser';

/**
 * Secretcv sonuç sayfasını kullanıcının tarayıcısında okuyan betik; sunucudaki ayrıştırıcıyla aynı selector'lar.
 * Kartlar: [bağlantı, başlık, firma, konum, ilan tarihi]. Sonraki sayfa: "sf" parametresi bir fazla olan bağlantı.
 */
export const SECRETCV_BROWSER_SCRIPT = `(() => {
  const S = ${JSON.stringify(SECRETCV.selectors)};
  const MARKERS = ${JSON.stringify(SECRETCV.blockMarkers)};
  const PAGE = ${JSON.stringify(SECRETCV.pageQuery)};
  const html = document.documentElement.outerHTML;
  const marker = MARKERS.find((m) => html.includes(m)) || null;
  const text = (el) => (el ? el.textContent.replace(/\\s+/g, ' ').trim() : '') || null;
  const cards = [...document.querySelectorAll(S.card)].map((el) => {
    const link = el.querySelector(S.title);
    return [link ? link.getAttribute('href') : null, text(link), text(el.querySelector(S.company)), text(el.querySelector(S.location)), text(el.querySelector(S.date))];
  });
  const current = Number(new URLSearchParams(location.search).get(PAGE)) || 1;
  const next = [...document.querySelectorAll('a[href]')].some((a) => {
    try {
      return Number(new URL(a.getAttribute('href'), location.origin).searchParams.get(PAGE)) === current + 1;
    } catch (e) {
      return false;
    }
  });
  const root = /^\\/is-ilanlari\\/[a-z0-9-]+-is-ilanlari\\/?$/.test(location.pathname) && !!document.querySelector('main');
  return 'JT_PAGE ' + JSON.stringify({ v: 1, source: 'secretcv', url: location.href, marker, root, next, cards });
})()`;

const str = (value: unknown) => (typeof value === 'string' && value.trim() ? value : null);

export function secretcvFromBrowser(payload: unknown, url: string): ParsedPage {
  const data = readBrowserPayload(payload, 'secretcv', url);
  assertReadable(data, url, `İlan listesi bulunamadı (${SECRETCV.selectors.card}); sayfa düzeni değişmiş olabilir`);
  const cards: RawCard[] = data.cards.map((row) => {
    const [href, title, company, location, date] = row.map(str);
    return { platformId: href?.split(/[?#]/)[0].match(SECRETCV.listingId)?.[1] ?? null, title, company, location, url: href, publishedText: secretcvDate(date) };
  });
  return { cards, hasNextPage: data.next };
}
