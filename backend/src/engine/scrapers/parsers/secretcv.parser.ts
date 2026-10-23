import * as cheerio from 'cheerio';
import { RawCard } from '../../../domain/scraped-jobs';
import { SECRETCV } from '../selectors/secretcv';
import { ParsedPage, ScrapeError } from '../types';

export const secretcvDate = (text: string | null | undefined) => text?.replace(SECRETCV.datePrefix, '').trim() || null;

/**
 * Sunucudaki sayfa: kartlar. Sonraki sayfa robots.txt'e göre okunamadığı için hasNextPage her zaman false; ilan
 * listesinin yapısı hiç yoksa selector hatası.
 */
export function parseSecretcvPage(html: string): ParsedPage {
  const $ = cheerio.load(html);
  const s = SECRETCV.selectors;
  const cards = $(s.card).toArray();
  if (!cards.length && !$(`a[href*="${SECRETCV.pageSuffix}"]`).length) throw new ScrapeError('selector', `İlan listesi bulunamadı (${s.card}); sayfa düzeni değişmiş olabilir`);
  const out: RawCard[] = cards.map((el) => {
    const card = $(el);
    const link = card.find(s.title).first();
    const href = link.attr('href') ?? null;
    return {
      platformId: href?.split(/[?#]/)[0].match(SECRETCV.listingId)?.[1] ?? null,
      title: link.text().trim() || null,
      company: card.find(s.company).first().text().trim() || null,
      location: card.find(s.location).first().text().trim() || null,
      url: href,
      publishedText: secretcvDate(card.find(s.date).first().text()),
    };
  });
  return { cards: out, hasNextPage: false };
}
