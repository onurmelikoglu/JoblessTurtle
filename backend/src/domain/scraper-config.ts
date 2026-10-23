import { z } from 'zod';
import { fold } from './text';

/**
 * İlan sitesi taramasının ayarları. Kod değiştirmeden API'den (POST /v1/scrapers/config) yönetilir ve anahtar-değer
 * kaydında saklanır; kayıtta olmayan alanlar buradaki varsayılanlardan gelir. Alan adları dışarıya açık sözleşmeyle
 * (snake_case) aynıdır.
 */
export const SCRAPER_SOURCES = ['kariyer_net', 'indeed', 'eleman_net', 'isinolsun', 'secretcv', 'yenibiris'] as const;
export type ScraperSource = (typeof SCRAPER_SOURCES)[number];

/** Taranan ilanların çalışma alanında kaydedildiği toplayıcı kaynak türü (bkz. engine/connectors/manual.ts). */
export const WORKSPACE_SOURCE_KIND: Record<ScraperSource, string> = {
  kariyer_net: 'scrape_kariyer_net',
  indeed: 'scrape_indeed',
  eleman_net: 'scrape_eleman_net',
  isinolsun: 'scrape_isinolsun',
  secretcv: 'scrape_secretcv',
  yenibiris: 'scrape_yenibiris',
};

export const SCRAPER_LABELS: Record<ScraperSource, string> = {
  kariyer_net: 'Kariyer.net',
  indeed: 'Indeed',
  eleman_net: 'Eleman.net',
  isinolsun: 'İşin Olsun',
  secretcv: 'Secretcv',
  yenibiris: 'Yenibiriş',
};

export function isScraperSource(value: unknown): value is ScraperSource {
  return typeof value === 'string' && (SCRAPER_SOURCES as readonly string[]).includes(value);
}

/**
 * query: anahtar kelime sitenin arama adresine yazılır. local_filter: site sayfası anahtar kelimesiz taranır ve ilanlar
 * başlık/firma üzerinden süzülür (anahtar kelimeli arama adresleri bot korumasına takılan siteler için).
 */
export const KEYWORD_MODES = ['query', 'local_filter'] as const;

const cityList = z.array(z.string().trim().min(2).max(60)).max(30);
const keywordList = z.array(z.string().trim().min(2).max(80)).max(20);

const sourceSchema = z.object({
  enabled: z.boolean(),
  interval_hours: z.number().min(1).max(168),
  max_pages: z.number().int().min(1).max(10),
  concurrency: z.number().int().min(1).max(3),
  request_delay_ms: z.number().int().min(1000).max(60_000),
  keyword_mode: z.enum(KEYWORD_MODES),
  cities: cityList.optional(),
  keywords: keywordList.optional(),
});

export const scraperConfigSchema = z.object({
  enabled: z.boolean(),
  sources: z.object(Object.fromEntries(SCRAPER_SOURCES.map((source) => [source, sourceSchema])) as Record<ScraperSource, typeof sourceSchema>),
  cities: cityList.min(1),
  keywords: keywordList,
  notify_only_new: z.boolean(),
  forward_to_workspaces: z.boolean(),
  max_retries: z.number().int().min(0).max(5),
  retry_base_ms: z.number().int().min(250).max(60_000),
  max_retry_after_seconds: z.number().int().min(0).max(3600),
  block_cooldown_hours: z.number().min(1).max(168),
  missing_after_hours: z.number().min(6).max(720),
  expire_after_days: z.number().min(1).max(180),
  run_timeout_minutes: z.number().int().min(5).max(360),
});

export type ScraperConfig = z.infer<typeof scraperConfigSchema>;
export type SourceScraperConfig = z.infer<typeof sourceSchema>;

export const DEFAULT_SCRAPER_CONFIG: ScraperConfig = {
  enabled: true,
  sources: {
    kariyer_net: { enabled: true, interval_hours: 4, max_pages: 5, concurrency: 1, request_delay_ms: 4000, keyword_mode: 'local_filter' },
    indeed: { enabled: true, interval_hours: 4, max_pages: 1, concurrency: 1, request_delay_ms: 5000, keyword_mode: 'query' },
    eleman_net: { enabled: true, interval_hours: 4, max_pages: 3, concurrency: 1, request_delay_ms: 4000, keyword_mode: 'query' },
    isinolsun: { enabled: true, interval_hours: 4, max_pages: 2, concurrency: 1, request_delay_ms: 4000, keyword_mode: 'query' },
    secretcv: { enabled: true, interval_hours: 4, max_pages: 1, concurrency: 1, request_delay_ms: 4000, keyword_mode: 'local_filter' },
    yenibiris: { enabled: false, interval_hours: 4, max_pages: 1, concurrency: 1, request_delay_ms: 5000, keyword_mode: 'query' },
  },
  cities: ['İstanbul', 'Ankara', 'İzmir', 'Kocaeli'],
  keywords: [],
  notify_only_new: true,
  forward_to_workspaces: true,
  max_retries: 2,
  retry_base_ms: 2000,
  max_retry_after_seconds: 120,
  block_cooldown_hours: 24,
  missing_after_hours: 48,
  expire_after_days: 14,
  run_timeout_minutes: 60,
};

type PlainObject = Record<string, unknown>;
const isPlainObject = (value: unknown): value is PlainObject => typeof value === 'object' && value !== null && !Array.isArray(value);

function deepMerge(base: PlainObject, patch: PlainObject): PlainObject {
  const out: PlainObject = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? deepMerge(base[key] as PlainObject, value) : value;
  }
  return out;
}

/** Kayıtlı ayar (eksik ya da eski olabilir) varsayılanlarla tamamlanır; geçersiz kayıt varsayılana döner. */
export function resolveScraperConfig(stored: unknown): ScraperConfig {
  const merged = deepMerge(DEFAULT_SCRAPER_CONFIG as unknown as PlainObject, isPlainObject(stored) ? stored : {});
  const parsed = scraperConfigSchema.safeParse(merged);
  return parsed.success ? parsed.data : DEFAULT_SCRAPER_CONFIG;
}

/** Kısmi güncelleme mevcut ayarın üzerine yazılır ve tamamı doğrulanır; hata varsa alan yollarıyla döner. */
export function applyScraperConfigPatch(current: ScraperConfig, patch: unknown): { config: ScraperConfig } | { errors: string[] } {
  if (!isPlainObject(patch)) return { errors: ['Ayar bir JSON nesnesi olmalı'] };
  const parsed = scraperConfigSchema.safeParse(deepMerge(current as unknown as PlainObject, patch));
  if (!parsed.success) return { errors: parsed.error.issues.map((issue) => `${issue.path.join('.') || '(kök)'}: ${issue.message}`) };
  return { config: parsed.data };
}

/** Sitenin bu çalışmada kullanacağı şehir ve anahtar kelimeler: siteye özel liste varsa o, yoksa genel liste. */
export function sourceTargets(config: ScraperConfig, source: ScraperSource): { cities: string[]; keywords: string[] } {
  const own = config.sources[source];
  return { cities: own.cities?.length ? own.cities : config.cities, keywords: own.keywords ?? config.keywords };
}

/** Arama adresinin sonundaki ek: eklenti bu sekmedeki sonuç sayfalarını kendiliğinden aktarır. */
export const EXTENSION_IMPORT_HASH = '#jt-import';
/** Profilde aranan pozisyonların hepsi aranır; çok uzun listede ilk bu kadarı (her biri site başına bir sekme). */
const EXTENSION_TITLES = 8;
const EXTENSION_CITIES = 4;

/**
 * Eklenti aramalarının unvan ve şehirleri: profillerin aranan pozisyonlarının hepsi (en çok EXTENSION_TITLES), profillerin şehir seçimindeki iller ("İstanbul
 * (Anadolu Yakası)" → "İstanbul"); hiçbir profilde şehir yoksa tarama ayarındaki şehirler. Tekrarlar harf ve büyük-küçük
 * farkından bağımsız elenir.
 */
export function searchTargetsOf(profiles: { titles: string[]; city: string | null }[], fallbackCities: string[]): { titles: string[]; cities: string[] } {
  const unique = (values: string[], limit: number) => {
    const seen = new Map<string, string>();
    for (const value of values.map((v) => v.replace(/\(.*\)/, '').replace(/\s+/g, ' ').trim()).filter(Boolean)) if (!seen.has(fold(value))) seen.set(fold(value), value);
    return [...seen.values()].slice(0, limit);
  };
  const cities = unique(profiles.flatMap((p) => (p.city ?? '').split(';')), EXTENSION_CITIES);
  return { titles: unique(profiles.flatMap((p) => p.titles), EXTENSION_TITLES), cities: cities.length ? cities : unique(fallbackCities, EXTENSION_CITIES) };
}
