import { SCRAPER_SOURCES } from '../../domain/scraper-config';
import { SCRAPERS } from './registry';

/** Eklentinin okuma dosyası (browser-extension/extractors.js), deponun kökünden. */
export const EXTRACTORS_PATH = 'browser-extension/extractors.js';

/**
 * Okuma betikleri eklentiye metin olarak değil kod olarak gömülür: MV3 içerik betiklerinde eval yoktur. Dosya
 * sunucudaki betiklerden üretilir (npm run extension:extractors); birim testi güncel olduğunu denetler.
 */
export function renderExtractors(): string {
  const entries = SCRAPER_SOURCES.map((source) => {
    const scraper = SCRAPERS[source];
    return [
      `  ${source}: {`,
      `    label: ${JSON.stringify(scraper.label)},`,
      `    origin: ${JSON.stringify(scraper.origin)},`,
      `    path: new RegExp(${JSON.stringify(scraper.searchPagePath.source)}),`,
      `    read: function () {`,
      `      return ${scraper.browserScript().split('\n').join('\n      ')};`,
      `    },`,
      `  },`,
    ].join('\n');
  });
  return [
    '// Bu dosya üretilir; elle düzenlenmez. Kaynak: backend/src/engine/scrapers/parsers/*.browser.ts',
    '// Yeniden üretmek için backend klasöründe: npm run extension:extractors',
    'globalThis.JT_EXTRACTORS = {',
    ...entries,
    '};',
    '',
  ].join('\n');
}
