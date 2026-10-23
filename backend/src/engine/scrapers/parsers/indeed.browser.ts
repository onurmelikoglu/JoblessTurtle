import { RawCard } from '../../../domain/scraped-jobs';
import { INDEED } from '../selectors/indeed';
import { ParsedPage } from '../types';
import { assertReadable, readBrowserPayload } from './browser-payload';
import { indeedLocation } from './indeed.parser';

/**
 * Indeed sonuç sayfasını kullanıcının tarayıcısında okuyan betik. Önce sayfaya gömülü ilan verisini
 * (mosaic-provider-jobcards) sunucudaki ayrıştırıcıyla aynı yöntemle okur, yoksa kartlara düşer (sayfadaki görünmez boş
 * kart unvansız olduğu için atlanır; 23 Ekim 2026'da gerçek sayfada görüldü). Kartlar kısa dizilerdir:
 * [ilan anahtarı, unvan, firma, konum, il kodu, uzaktan (1/0), çalışma türleri, yayın zamanı (ms), göreli tarih, firma sayfası].
 */
export const INDEED_BROWSER_SCRIPT = `(() => {
  const S = ${JSON.stringify(INDEED.selectors)};
  const MARKERS = ${JSON.stringify(INDEED.blockMarkers)};
  const EMBEDDED = ${JSON.stringify(INDEED.embeddedData)};
  const html = document.documentElement.outerHTML;
  const marker = MARKERS.find((m) => html.includes(m)) || null;
  const objectAt = (src, start) => {
    const open = src.indexOf('{', start);
    if (open < 0) return null;
    let depth = 0, inString = false, escaped = false;
    for (let i = open; i < src.length; i++) {
      const ch = src[i];
      if (inString) { if (escaped) escaped = false; else if (ch === '\\\\') escaped = true; else if (ch === '"') inString = false; continue; }
      if (ch === '"') inString = true; else if (ch === '{') depth++; else if (ch === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
    }
    return null;
  };
  let results = null;
  const script = [...document.scripts].map((s) => s.textContent || '').find((t) => t.includes(EMBEDDED));
  if (script) {
    try {
      const data = JSON.parse(objectAt(script, script.indexOf(EMBEDDED) + EMBEDDED.length));
      results = data.metaData.mosaicProviderJobCardsModel.results;
    } catch (e) { results = null; }
  }
  const text = (el) => (el ? el.textContent.replace(/\\s+/g, ' ').trim() : '') || null;
  const cards = Array.isArray(results)
    ? results.map((r) => [r.jobkey || null, r.displayTitle || r.title || null, r.company || null, r.formattedLocation || r.jobLocationCity || null, r.jobLocationState || null, r.remoteLocation ? 1 : 0, (r.jobTypes || []).join(', ') || null, r.pubDate || null, r.formattedRelativeTime || null, r.companyOverviewLink || null])
    : [...document.querySelectorAll(S.card)].map((a) => {
        const root = a.closest(S.cardRoot);
        return [a.getAttribute('data-jk'), text(a.querySelector(S.title)) || text(a), root ? text(root.querySelector(S.company)) : null, root ? text(root.querySelector(S.location)) : null, null, 0, null, null, null, null];
      }).filter((row) => row[1]);
  return 'JT_PAGE ' + JSON.stringify({ v: 1, source: 'indeed', url: location.href, marker, root: Array.isArray(results), next: cards.length >= ${INDEED.pageSize}, cards });
})()`;

const str = (value: unknown) => (typeof value === 'string' && value.trim() ? value : null);

/** Indeed betiğinin kartları; konum il plaka koduyla sunucudaki ayrıştırıcı gibi ile bağlanır. */
export function indeedFromBrowser(payload: unknown, url: string): ParsedPage {
  const data = readBrowserPayload(payload, 'indeed', url);
  assertReadable(data, url, `İlan verisi bulunamadı (gömülü veri ve ${INDEED.selectors.card} yok); sayfa düzeni değişmiş olabilir`);
  const cards: RawCard[] = data.cards.map((row) => {
    const [jobKey, title, company, location, state, remote, jobTypes, pubDate, relative, companyUrl] = row;
    const at = typeof pubDate === 'number' && pubDate > 0 ? new Date(pubDate) : null;
    return {
      platformId: str(jobKey),
      title: str(title),
      company: str(company),
      location: indeedLocation({ formattedLocation: str(location) ?? undefined, jobLocationState: str(state) ?? undefined }),
      url: str(jobKey) ? INDEED.viewJobPath(String(jobKey)) : null,
      companyUrl: str(companyUrl),
      employmentType: str(jobTypes),
      workModeText: remote === 1 ? 'Uzaktan' : null,
      publishedAt: at && !Number.isNaN(at.getTime()) ? at : null,
      publishedText: str(relative),
    };
  });
  return { cards, hasNextPage: data.next };
}
