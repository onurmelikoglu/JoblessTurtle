import { z } from 'zod';
import { ScrapeError } from '../types';

const MAX_CARDS = 200;
const MAX_CELLS = 20;
const MAX_CELL_LENGTH = 2000;

/**
 * Tarayıcıdaki okuma betiklerinin ortak çıktısı ("JT_PAGE " önekinden sonraki JSON). marker: sayfada görülen bot
 * koruması işareti; root: ilan listesinin kökü (ya da gömülü ilan verisi) bulundu mu; next: sonraki sayfa var mı;
 * cards: siteye özel sırayla kısa diziler.
 */
export const browserPayloadSchema = z.object({
  v: z.literal(1),
  source: z.string(),
  url: z.string(),
  marker: z.string().nullable(),
  root: z.boolean().optional(),
  next: z.boolean(),
  cards: z.array(z.array(z.union([z.string().max(MAX_CELL_LENGTH), z.number(), z.null()])).max(MAX_CELLS)).max(MAX_CARDS),
});
export type BrowserPayload = z.infer<typeof browserPayloadSchema>;

/** Betik çıktısı biçime uymuyorsa ya da başka bir sitenin betiğinden geldiyse sayfa okunmamış sayılır. */
export function readBrowserPayload(payload: unknown, source: string, url: string): BrowserPayload {
  const parsed = browserPayloadSchema.safeParse(payload);
  if (!parsed.success || parsed.data.source !== source) throw new ScrapeError('parse', 'Tarayıcıdan gelen sayfa verisi okunamadı', { url });
  return parsed.data;
}

/** Kart yoksa önce doğrulama sayfası ("blocked"), sonra yapının kendisi ("selector") sorulur; kart varsa sayfa okunmuştur. */
export function assertReadable(data: BrowserPayload, url: string, missingStructure: string): void {
  if (data.cards.length) return;
  if (data.marker) throw new ScrapeError('blocked', `Doğrulama sayfası (${data.marker})`, { url });
  if (!data.root) throw new ScrapeError('selector', missingStructure, { url });
}
