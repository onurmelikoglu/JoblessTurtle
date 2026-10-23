import * as cheerio from 'cheerio';
import { RawCard } from '../../../domain/scraped-jobs';
import { ELEMAN_NET } from '../selectors/eleman-net';
import { ParsedPage, ScrapeError } from '../types';

const LINE_BREAK = /<br\s*\/?>/i;

/** Alt başlığın iki satırı: firma ve konum ("Firma Adı Gizli <br> İstanbul Anadolu - Adalar"). */
export function elemanSubtitle(html: string | null): { company: string | null; location: string | null } {
  const [company, location] = (html ?? '').split(LINE_BREAK).map((part) => cheerio.load(`<p>${part}</p>`)('p').text().replace(/\s+/g, ' ').trim() || null);
  return { company: company ?? null, location: location ?? null };
}

/** Sonraki sayfa: "sy" parametresi bir fazla olan bağlantı. */
export function hasPageLink(hrefs: (string | undefined)[], param: string, page: number): boolean {
  return hrefs.some((href) => {
    if (!href) return false;
    try {
      return Number(new URL(href, 'https://example.test').searchParams.get(param)) === page + 1;
    } catch {
      return false;
    }
  });
}

export function parseElemanNetPage(html: string, ctx: { page: number }): ParsedPage {
  const $ = cheerio.load(html);
  const s = ELEMAN_NET.selectors;
  const cards = $(s.card).toArray();
  if (!cards.length && !$(`form[action$="${ELEMAN_NET.searchPath}"]`).length) throw new ScrapeError('selector', `İlan listesi bulunamadı (${s.card}); sayfa düzeni değişmiş olabilir`);
  const out: RawCard[] = cards.map((el) => {
    const card = $(el);
    const href = card.find(s.link).first().attr('href') ?? null;
    const title = card.find(s.title).first().clone();
    title.find(s.titleNoise).remove();
    const { company, location } = elemanSubtitle(card.find(s.subtitle).first().html());
    const description = card
      .find(s.text)
      .toArray()
      .filter((t) => !$(t).find('i').length)
      .map((t) => $(t).text().trim())
      .find(Boolean);
    return {
      platformId: href?.split(/[?#]/)[0].match(ELEMAN_NET.listingId)?.[1] ?? null,
      title: title.text().trim() || null,
      company,
      location,
      url: href,
      description: description ?? null,
    };
  });
  return { cards: out, hasNextPage: hasPageLink($('a[href]').toArray().map((a) => $(a).attr('href')), ELEMAN_NET.pageQuery, ctx.page) };
}
