import { RawCard } from '../../../domain/scraped-jobs';
import { KARIYER_NET } from '../selectors/kariyer-net';
import { ParsedPage } from '../types';
import { assertReadable, readBrowserPayload } from './browser-payload';
import { stripCompanyPrefix } from './kariyer-net.parser';

/**
 * Kariyer.net sonuç sayfasını kullanıcının tarayıcısında okuyan betik. Sunucudaki ayrıştırıcıyla aynı selector'ları
 * kullanır; kartları kısa diziler olarak döndürür: [bağlantı, başlık, firma, konum, çalışma türü, çalışma modeli,
 * tarih metni, tarih durumu]. Sonraki sayfa: şehir sayfalarında yol eki ("/is-ilanlari/istanbul-2" → "-3"), anahtar
 * kelimeli aramada "cp" parametresi ("/is-ilanlari/istanbul-2?ct=34,82&kw=yazılım&cp=2", çok şehirli aramada
 * "/is-ilanlari?ct=34,82,41&kw=…&cp=2"; 23 Ekim 2026'da gerçek sayfadan).
 */
export const KARIYER_NET_BROWSER_SCRIPT = `(() => {
  const S = ${JSON.stringify(KARIYER_NET.selectors)};
  const A = ${JSON.stringify(KARIYER_NET.attributes)};
  const MARKERS = ${JSON.stringify(KARIYER_NET.blockMarkers)};
  const html = document.documentElement.outerHTML;
  const marker = MARKERS.find((m) => html.includes(m)) || null;
  const text = (el) => (el ? el.textContent.replace(/\\s+/g, ' ').trim() : '') || null;
  const cards = [...document.querySelectorAll(S.card)].map((el) => {
    const link = el.querySelector(S.link);
    const date = el.querySelector(S.date);
    let dateText = null;
    if (date) {
      const copy = date.cloneNode(true);
      copy.querySelectorAll('i').forEach((i) => i.remove());
      dateText = text(copy);
    }
    return [link ? link.getAttribute('href') : null, text(el.querySelector(S.title)), text(el.querySelector(S.company)), text(el.querySelector(S.location)) || el.getAttribute(A.city), el.getAttribute(A.workType), el.getAttribute(A.workModel) || text(el.querySelector(S.workModel)), dateText, el.getAttribute(A.dateStatus)];
  });
  const m = location.pathname.match(/^\\/is-ilanlari\\/(.+?)(?:-(\\d+))?\\/?$/);
  const nextPath = m ? '/is-ilanlari/' + m[1] + '-' + ((Number(m[2]) || 1) + 1) : null;
  const cp = Number(new URLSearchParams(location.search).get('cp')) || 1;
  const hrefs = [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href'));
  const nextQueryPage = hrefs.some((href) => {
    try {
      const u = new URL(href, location.origin);
      return u.pathname.startsWith('/is-ilanlari') && u.searchParams.has('kw') && Number(u.searchParams.get('cp')) === cp + 1;
    } catch (e) {
      return false;
    }
  });
  const next = nextQueryPage || (!location.search.includes('kw=') && !!nextPath && hrefs.some((href) => href.split('?')[0] === nextPath));
  return 'JT_PAGE ' + JSON.stringify({ v: 1, source: 'kariyer_net', url: location.href, marker, root: !!document.querySelector(S.listRoot), next, cards });
})()`;

const str = (value: unknown) => (typeof value === 'string' ? value : null);

/** Kariyer.net betiğinin kartları; sunucudaki ayrıştırıcıyla aynı alanlar (başlıktaki firma öneki, güncelleme tarihi). */
export function kariyerNetFromBrowser(payload: unknown, url: string): ParsedPage {
  const data = readBrowserPayload(payload, 'kariyer_net', url);
  assertReadable(data, url, `İlan listesi bulunamadı (${KARIYER_NET.selectors.listRoot} / ${KARIYER_NET.selectors.card}); sayfa düzeni değişmiş olabilir`);
  const cards: RawCard[] = data.cards.map((row) => {
    const [href, title, company, location, workType, workModel, dateText, dateStatus] = row.map(str);
    const path = href ? href.split(/[?#]/)[0] : '';
    return {
      platformId: path.match(KARIYER_NET.listingPath)?.[1] ?? null,
      title: title && company ? stripCompanyPrefix(title, company) : title,
      company,
      location,
      url: href,
      employmentType: workType,
      workModeText: workModel,
      publishedText: dateText,
      dateIsUpdate: dateStatus === KARIYER_NET.updatedDateStatus,
    };
  });
  return { cards, hasNextPage: data.next };
}
