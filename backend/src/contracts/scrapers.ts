/**
 * İlan sitesi taraması API'sinin (/v1/scrapers) yanıt sözleşmesi. Alan adları dışarıya açık sözleşmeyle aynı biçimdedir
 * (snake_case); diğer servisler ve web arayüzü bu dosyayı yalnızca tip olarak içe aktarır.
 */
import type { ScraperConfig, ScraperSource } from '../domain/scraper-config';
import type { IsoDate } from './wire';

export type { ScraperConfig, ScraperSource };

export type ScraperRunState = 'queued' | 'running' | 'succeeded' | 'partial' | 'blocked' | 'rate_limited' | 'failed' | 'skipped';
export type ScraperHealth = 'ok' | 'partial' | 'blocked' | 'rate_limited' | 'failed' | 'disabled' | 'never';
export type ScraperErrorKind = 'blocked' | 'rate_limited' | 'robots' | 'login_required' | 'selector' | 'parse' | 'network' | 'forward';

export interface ScraperRunError {
  kind: ScraperErrorKind;
  message: string;
  city?: string;
  keyword?: string | null;
  page?: number;
  url?: string;
  status?: number;
  /** ISO 8601; çalışma kaydının JSON alanında metin olarak saklanır. */
  at: string;
}

export interface ScraperRunView {
  id: string;
  source: string;
  trigger: string;
  state: ScraperRunState;
  cities: string[];
  keywords: string[];
  max_pages: number;
  pages_visited: number;
  pages_failed: number;
  listings_found: number;
  listings_new: number;
  listings_updated: number;
  duplicates: number;
  forwarded: number;
  error_summary: string | null;
  errors: ScraperRunError[];
  queued_at: IsoDate;
  started_at: IsoDate | null;
  finished_at: IsoDate | null;
  duration_ms: number | null;
}

export interface ScraperSourceStatus {
  source: ScraperSource;
  label: string;
  enabled: boolean;
  interval_hours: number;
  max_pages: number;
  keyword_mode: 'query' | 'local_filter';
  cities: string[];
  keywords: string[];
  health: ScraperHealth;
  last_run: ScraperRunView | null;
  active_run: ScraperRunView | null;
  next_run_at: IsoDate | null;
  active_jobs: number;
  new_jobs_24h: number;
}

export interface ScraperStatus {
  enabled: boolean;
  server_enabled: boolean;
  sources: ScraperSourceStatus[];
}

export interface ScraperHistoryPage {
  items: ScraperRunView[];
  next_cursor: string | null;
}

export interface ScrapedJobView {
  id: string;
  source: string;
  external_id: string;
  company_name: string;
  job_title: string;
  city: string;
  district: string | null;
  job_url: string;
  company_url: string | null;
  description: string | null;
  employment_type: string | null;
  work_mode: string | null;
  published_at: IsoDate | null;
  published_text: string | null;
  status: 'active' | 'missing' | 'expired';
  duplicate_of: string | null;
  first_seen_at: IsoDate;
  last_seen_at: IsoDate;
  content_changed_at: IsoDate | null;
}

export interface ScrapedJobsPage {
  items: ScrapedJobView[];
  total: number;
  next_cursor: string | null;
}

export interface ScraperRunRequest {
  source?: ScraperSource | 'all';
  cities?: string[];
  keywords?: string[];
  max_pages?: number;
}

export interface ScraperRunResponse {
  runs: (ScraperRunView & { already_running: boolean })[];
}

/** Eklentinin aktardığı sayfanın sonucu. verification: sayfada doğrulama (CAPTCHA) vardı, çalışma açılmadı. */
export type ScraperImportResult =
  | {
      status: 'imported';
      run_id: string;
      state: 'succeeded' | 'partial';
      listings_found: number;
      listings_new: number;
      listings_updated: number;
      /** Kullanıcının arama profillerine yeni eklenen ilan sayısı. */
      forwarded: number;
      has_next_page: boolean;
    }
  | { status: 'verification'; message: string }
  | { status: 'failed'; run_id: string; message: string };

export interface ScraperImportRequest {
  source: ScraperSource;
  url: string;
  /** Okuma betiğinin döndürdüğü "JT_PAGE " sonrası JSON. */
  payload: unknown;
}

export interface ExtensionSearch {
  source: ScraperSource;
  label: string;
  city: string;
  keyword: string | null;
  url: string;
}

export interface ExtensionSearchesResponse {
  searches: ExtensionSearch[];
}

/** Eklenti anahtarının durumu; anahtarın kendisi yalnızca üretildiği yanıtta bir kez döner. */
export interface ExtensionKeyStatus {
  exists: boolean;
  created_at: IsoDate | null;
  last_used_at: IsoDate | null;
}

export interface ExtensionKeyCreated {
  key: string;
  created_at: IsoDate;
}
