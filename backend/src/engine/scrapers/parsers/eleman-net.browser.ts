import { RawCard } from '../../../domain/scraped-jobs';
import { ELEMAN_NET } from '../selectors/eleman-net';
import { ParsedPage } from '../types';
import { assertReadable, readBrowserPayload } from './browser-payload';

/**
 * Eleman.net sonuç sayfasını kullanıcının tarayıcısında okuyan betik; sunucudaki ayrıştırıcıyla aynı selector'lar.
 * Kartlar: [bağlantı, başlık, firma, konum, açıklama]. Sonraki sayfa: "sy" parametresi bir fazla olan bağlantı.
 */
export const ELEMAN_NET_BROWSER_SCRIPT = `(() => {
  const S = ${JSON.stringify(ELEMAN_NET.selectors)};
  const MARKERS = ${JSON.stringify(ELEMAN_NET.blockMarkers)};
  const PAGE = ${JSON.stringify(ELEMAN_NET.pageQuery)};
  const html = document.documentElement.outerHTML;
  const marker = MARKERS.find((m) => html.includes(m)) || null;
  const clean = (value) => (value || '').replace(/\\s+/g, ' ').trim() || null;
  const lines = (el) => {
    if (!el) return [null, null];
    const holder = document.createElement('div');
    return el.innerHTML.split(/<br\\s*\\/?>/i).map((part) => {
      holder.innerHTML = part;
      return clean(holder.textContent);
    });
  };
  const cards = [...document.querySelectorAll(S.card)].map((el) => {
    const link = el.querySelector(S.link);
    const title = el.querySelector(S.title);
    let titleText = null;
    if (title) {
      const copy = title.cloneNode(true);
      copy.querySelectorAll(S.titleNoise).forEach((n) => n.remove());
      titleText = clean(copy.textContent);
    }
    const [company, place] = lines(el.querySelector(S.subtitle));
    const description = [...el.querySelectorAll(S.text)].filter((t) => !t.querySelector('i')).map((t) => clean(t.textContent)).find(Boolean) || null;
    return [link ? link.getAttribute('href') : null, titleText, company || null, place || null, description];
  });
  const current = Number(new URLSearchParams(location.search).get(PAGE)) || 1;
  const next = [...document.querySelectorAll('a[href]')].some((a) => {
    try {
      return Number(new URL(a.getAttribute('href'), location.origin).searchParams.get(PAGE)) === current + 1;
    } catch (e) {
      return false;
    }
  });
  return 'JT_PAGE ' + JSON.stringify({ v: 1, source: 'eleman_net', url: location.href, marker, root: !!document.querySelector('form[action$="${ELEMAN_NET.searchPath}"]'), next, cards });
})()`;

const str = (value: unknown) => (typeof value === 'string' && value.trim() ? value : null);

export function elemanNetFromBrowser(payload: unknown, url: string): ParsedPage {
  const data = readBrowserPayload(payload, 'eleman_net', url);
  assertReadable(data, url, `İlan listesi bulunamadı (${ELEMAN_NET.selectors.card}); sayfa düzeni değişmiş olabilir`);
  const cards: RawCard[] = data.cards.map((row) => {
    const [href, title, company, location, description] = row.map(str);
    return { platformId: href?.split(/[?#]/)[0].match(ELEMAN_NET.listingId)?.[1] ?? null, title, company, location, url: href, description };
  });
  return { cards, hasNextPage: data.next };
}
