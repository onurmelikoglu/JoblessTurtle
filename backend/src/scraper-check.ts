import { env } from './common/env';
import { errorMessage } from './common/errors';
import { isRejection, normalizeCard } from './domain/scraped-jobs';
import { DEFAULT_SCRAPER_CONFIG, isScraperSource, SCRAPER_SOURCES, ScraperSource } from './domain/scraper-config';
import { ScraperHttpClient } from './engine/scrapers/http-client';
import { RateLimiter } from './engine/scrapers/rate-limiter';
import { SCRAPERS } from './engine/scrapers/registry';
import { ScrapeError } from './engine/scrapers/types';

/**
 * Canlı yapı kontrolü: her siteden tek bir sonuç sayfası (robots.txt'e uyarak, gerçek kullanıcı ajanıyla) istenir ve
 * üretimdeki ayrıştırıcıyla okunur. Veritabanına yazmaz, yeniden denemez. Site düzeni değişti mi, erişim engelli mi
 * görmek içindir. Kullanım: npm run scrapers:check -- [kariyer_net|indeed|eleman_net|isinolsun|secretcv|yenibiris] [şehir] [anahtar kelime]
 */
async function check(source: ScraperSource, city: string, keyword: string | null) {
  const scraper = SCRAPERS[source];
  const client = new ScraperHttpClient({
    userAgent: env().HTTP_USER_AGENT,
    maxRetries: 0,
    retryBaseMs: 1000,
    maxRetryAfterSeconds: 0,
    limiter: new RateLimiter(DEFAULT_SCRAPER_CONFIG.sources[source].request_delay_ms),
    blockMarkers: scraper.blockMarkers,
  });
  const target = { city, keyword: scraper.supportsKeywordQuery ? keyword : null };
  const url = scraper.searchUrl(target, 1);
  try {
    const page = await client.get(url);
    const parsed = scraper.parsePage(page, { url, target, page: 1 });
    const listings = parsed.cards.map((card) => normalizeCard(source, card, { origin: scraper.origin, searchedCity: city, now: new Date() }));
    const valid = listings.filter((l) => !isRejection(l));
    console.log(`✔ ${scraper.label}: HTTP ${page.status}, ${parsed.cards.length} kart, ${valid.length} geçerli ilan, sonraki sayfa ${parsed.hasNextPage ? 'var' : 'yok'} — ${url}`);
    for (const l of valid.slice(0, 3)) if (!isRejection(l)) console.log(`   ${l.companyName} — ${l.jobTitle} (${l.city}${l.district ? ` / ${l.district}` : ''})`);
    return true;
  } catch (e) {
    const kind = e instanceof ScrapeError ? e.kind : 'error';
    console.log(`✘ ${scraper.label}: [${kind}] ${errorMessage(e)} — ${url}`);
    return false;
  }
}

async function main() {
  const [sourceArg, cityArg, ...keywordParts] = process.argv.slice(2);
  const sources = (sourceArg && isScraperSource(sourceArg) ? [sourceArg] : [...SCRAPER_SOURCES]).filter((source) => {
    if (SCRAPERS[source].serverScraping) return true;
    console.log(`– ${SCRAPERS[source].label}: sunucu taraması yok (yalnızca tarayıcı eklentisi); istek atılmadı`);
    return false;
  });
  const keyword = keywordParts.join(' ').trim() || null;
  let allOk = true;
  for (const source of sources) allOk = (await check(source, cityArg ?? 'İstanbul', keyword)) && allOk;
  process.exit(allOk ? 0 : 2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
