import { ScraperSource } from '../../domain/scraper-config';
import { BaseScraper } from './base-scraper';
import { IndeedScraper } from './indeed.scraper';
import { KariyerNetScraper } from './kariyer-net.scraper';

/** Yeni site: BaseScraper'dan türeyen sınıf + selector dosyası + ayrıştırıcı, ardından buraya ve SCRAPER_SOURCES'a eklenir. */
export const SCRAPERS: Record<ScraperSource, BaseScraper> = {
  kariyer_net: new KariyerNetScraper(),
  indeed: new IndeedScraper(),
};

