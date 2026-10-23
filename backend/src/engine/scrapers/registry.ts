import { ScraperSource } from '../../domain/scraper-config';
import { BaseScraper } from './base-scraper';
import { ElemanNetScraper } from './eleman-net.scraper';
import { IndeedScraper } from './indeed.scraper';
import { IsinolsunScraper } from './isinolsun.scraper';
import { KariyerNetScraper } from './kariyer-net.scraper';
import { SecretcvScraper } from './secretcv.scraper';
import { YenibirisScraper } from './yenibiris.scraper';

/** Yeni site: BaseScraper'dan türeyen sınıf + selector dosyası + ayrıştırıcı, ardından buraya ve SCRAPER_SOURCES'a eklenir. */
export const SCRAPERS: Record<ScraperSource, BaseScraper> = {
  kariyer_net: new KariyerNetScraper(),
  indeed: new IndeedScraper(),
  eleman_net: new ElemanNetScraper(),
  isinolsun: new IsinolsunScraper(),
  secretcv: new SecretcvScraper(),
  yenibiris: new YenibirisScraper(),
};

