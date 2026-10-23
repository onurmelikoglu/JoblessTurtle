import * as cheerio from 'cheerio';
import { RawCard } from '../../../domain/scraped-jobs';
import { YENIBIRIS } from '../selectors/yenibiris';
import { ParsedPage, ScrapeError } from '../types';
import { hasPageLink } from './eleman-net.parser';

/** Etiketler: çalışma türü ("Tam zamanlı") ve çalışma modeli ("İş Yerinde", "Hibrit", "Uzaktan"). */
export function yenibirisTags(tags: string[]): { employmentType: string | null; workModeText: string | null } {
  const mode = tags.find((t) => /yerinde|hibrit|uzaktan|remote/i.test(t)) ?? null;
  return { employmentType: tags.find((t) => t !== mode) ?? null, workModeText: mode };
}

/** Sunucu taraması kapalı; ayrıştırıcı kayıtlı sayfaların ve tarayıcı betiğinin karşılaştırılması için tutulur. */
export function parseYenibirisPage(html: string, ctx: { page: number }): ParsedPage {
  const $ = cheerio.load(html);
  const s = YENIBIRIS.selectors;
  const cards = $(s.card).filter((_, el) => $(el).find(s.title).length > 0).toArray();
  if (!cards.length && !$(`form[action="${YENIBIRIS.searchPath}"]`).length) throw new ScrapeError('selector', `İlan listesi bulunamadı (${s.card}); sayfa düzeni değişmiş olabilir`);
  const out: RawCard[] = cards.map((el) => {
    const card = $(el);
    const link = card.find(s.title).first();
    const href = link.attr('href') ?? null;
    const company = card.find(s.company).first();
    return {
      platformId: href?.split(/[?#]/)[0].match(YENIBIRIS.listingId)?.[1] ?? null,
      title: link.text().trim() || null,
      company: company.attr('title')?.trim() || company.text().trim() || null,
      location: card.find(s.location).first().text().trim() || null,
      url: href,
      publishedText: card.find(s.date).first().text().trim() || null,
      ...yenibirisTags(card.find(s.tag).toArray().map((t) => $(t).text().trim()).filter(Boolean)),
    };
  });
  return { cards: out, hasNextPage: hasPageLink($('a[href]').toArray().map((a) => $(a).attr('href')), YENIBIRIS.pageQuery, ctx.page) };
}
