import { SCRAPER_SOURCES } from '../../domain/scraper-config';
import { SCRAPERS } from './registry';
import { INDEED } from './selectors/indeed';
import { KARIYER_NET } from './selectors/kariyer-net';

/** Eklentinin okuma dosyası (browser-extension/extractors.js), deponun kökünden. */
export const EXTRACTORS_PATH = 'browser-extension/extractors.js';

/** Eklentinin hangi sayfada hangi betiği çalıştıracağı: sitenin kökü ve arama sonuç sayfası yolu. */
const SEARCH_PAGES = {
  kariyer_net: { origin: KARIYER_NET.origin, path: KARIYER_NET.searchPagePath.source },
  indeed: { origin: INDEED.origin, path: `^${INDEED.searchPath}\\/?$` },
} as const;

/**
 * Okuma betikleri eklentiye metin olarak değil kod olarak gömülür: MV3 içerik betiklerinde eval yoktur. Dosya
 * sunucudaki betiklerden üretilir (npm run extension:extractors); birim testi güncel olduğunu denetler.
 */
export function renderExtractors(): string {
  const entries = SCRAPER_SOURCES.map((source) => {
    const scraper = SCRAPERS[source];
    const page = SEARCH_PAGES[source];
    return [
      `  ${source}: {`,
      `    label: ${JSON.stringify(scraper.label)},`,
      `    origin: ${JSON.stringify(page.origin)},`,
      `    path: new RegExp(${JSON.stringify(page.path)}),`,
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
