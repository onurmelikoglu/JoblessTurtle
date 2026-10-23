import * as cheerio from 'cheerio';
import { citySlug } from '../../../domain/provinces';
import { RawCard } from '../../../domain/scraped-jobs';
import { fold } from '../../../domain/text';
import { KARIYER_NET } from '../selectors/kariyer-net';
import { ParsedPage, ScrapeError } from '../types';

const LEADING_SEPARATOR = /^\s*[-–—:|]\s*/;

/** Sponsorlu kartlarda başlık "Firma-Pozisyon" biçiminde gelir; firma adı başlıktan ayrılır. */
export function stripCompanyPrefix(title: string, company: string): string {
  const clean = title.replace(/\s+/g, ' ').trim();
  const name = company.replace(/\s+/g, ' ').trim();
  if (!name || fold(clean) === fold(name) || !fold(clean).startsWith(fold(name))) return clean;
  const rest = clean.slice(name.length);
  return LEADING_SEPARATOR.test(rest) ? rest.replace(LEADING_SEPARATOR, '').trim() || clean : clean;
}

/** Şehir adı Kariyer.net adres ekine çevrilir: "İstanbul" → "istanbul", "Kahramanmaraş" → "kahramanmaras". */
export const kariyerCitySlug = citySlug;

/** Bir sonuç sayfasını kartlara ayırır. Sayfa yapısı yoksa (liste kökü ve kart yok) selector hatası fırlatır. */
export function parseKariyerNetPage(html: string, ctx: { citySlug: string; page: number }): ParsedPage {
  const $ = cheerio.load(html);
  const s = KARIYER_NET.selectors;
  const a = KARIYER_NET.attributes;
  const cards = $(s.card).toArray();
  if (!cards.length && !$(s.listRoot).length) throw new ScrapeError('selector', `İlan listesi bulunamadı (${s.listRoot} / ${s.card}); sayfa düzeni değişmiş olabilir`);

  const out: RawCard[] = cards.map((el) => {
    const card = $(el);
    const link = card.find(s.link).first();
    const href = link.attr('href') ?? null;
    const path = href ? href.split(/[?#]/)[0] : '';
    const company = card.find(s.company).first().text().trim() || null;
    const rawTitle = card.find(s.title).first().text().trim() || null;
    const date = card.find(s.date).first().clone();
    date.find('i').remove();
    return {
      platformId: path.match(KARIYER_NET.listingPath)?.[1] ?? null,
      title: rawTitle && company ? stripCompanyPrefix(rawTitle, company) : rawTitle,
      company,
      location: card.find(s.location).first().text().trim() || card.attr(a.city) || null,
      url: href,
      employmentType: card.attr(a.workType) ?? null,
      workModeText: card.attr(a.workModel) ?? (card.find(s.workModel).first().text().trim() || null),
      publishedText: date.text().trim() || null,
      dateIsUpdate: card.attr(a.dateStatus) === KARIYER_NET.updatedDateStatus,
    };
  });
  const nextPath = KARIYER_NET.cityPath(ctx.citySlug, ctx.page + 1);
  const hasNextPage = $(`a[href="${nextPath}"], a[href^="${nextPath}?"]`).length > 0;
  return { cards: out, hasNextPage };
}
