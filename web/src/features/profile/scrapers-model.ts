import type { ScraperErrorKind, ScraperHealth, ScraperRunState, ScraperRunView, ScraperSourceStatus } from '@/api/types';
import type { Tone } from '@/ui/tones';

export const INTERVAL_OPTIONS = [1, 2, 3, 4, 6, 8, 12, 24] as const;
export const PAGE_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
/** Sırada ya da çalışan tarama varken durum sık yenilenir; yokken seyrek. */
export const ACTIVE_POLL_MS = 5_000;
export const IDLE_POLL_MS = 60_000;

const HEALTH: Record<ScraperHealth, { label: string; tone: Tone }> = {
  ok: { label: 'Çalışıyor', tone: 'good' },
  partial: { label: 'Kısmen alındı', tone: 'warn' },
  blocked: { label: 'Site engelledi', tone: 'bad' },
  rate_limited: { label: 'İstek sınırı', tone: 'bad' },
  failed: { label: 'Başarısız', tone: 'bad' },
  disabled: { label: 'Kapalı', tone: 'neutral' },
  never: { label: 'Henüz taranmadı', tone: 'neutral' },
};

const STATE_LABEL: Record<ScraperRunState, string> = {
  queued: 'Sırada',
  running: 'Taranıyor',
  succeeded: 'Tamamlandı',
  partial: 'Kısmen alındı',
  blocked: 'Site engelledi',
  rate_limited: 'İstek sınırı',
  failed: 'Başarısız',
  skipped: 'Atlandı',
};

const STATE_TONE: Record<ScraperRunState, Tone> = { queued: 'info', running: 'info', succeeded: 'good', partial: 'warn', blocked: 'bad', rate_limited: 'bad', failed: 'bad', skipped: 'neutral' };

const ERROR_KIND: Record<ScraperErrorKind, string> = {
  blocked: 'erişim engeli',
  rate_limited: 'istek sınırı',
  robots: 'robots.txt yasağı',
  login_required: 'giriş isteniyor',
  selector: 'sayfa düzeni değişmiş',
  parse: 'okunamayan içerik',
  network: 'bağlantı hatası',
  forward: 'çalışma alanına aktarım',
};

export const healthOf = (health: ScraperHealth) => HEALTH[health];
export const stateLabel = (state: ScraperRunState) => STATE_LABEL[state];
export const stateTone = (state: ScraperRunState) => STATE_TONE[state];

export const isActive = (sources: ScraperSourceStatus[] | undefined) => !!sources?.some((s) => s.active_run);

/** "3 sayfa · 159 ilan, 12 yeni, 2 güncellenen · 1 sayfa alınamadı" */
export function runSummary(run: Pick<ScraperRunView, 'pages_visited' | 'pages_failed' | 'listings_found' | 'listings_new' | 'listings_updated'>): string {
  const parts = [`${run.pages_visited} sayfa`, `${run.listings_found} ilan, ${run.listings_new} yeni${run.listings_updated ? `, ${run.listings_updated} güncellenen` : ''}`];
  if (run.pages_failed) parts.push(`${run.pages_failed} sayfa alınamadı`);
  return parts.join(' · ');
}

/** Çalışmadaki hata türleri, tekrarsız ve okunur adlarıyla. */
export function errorKinds(run: Pick<ScraperRunView, 'errors'>): string {
  return [...new Set(run.errors.map((e) => ERROR_KIND[e.kind] ?? e.kind))].join(', ');
}

/** Anahtar kelimenin nasıl kullanıldığı: sitenin aramasında mı, sonuçların süzülmesinde mi. */
export function keywordNote(source: Pick<ScraperSourceStatus, 'keyword_mode' | 'keywords'>): string {
  if (!source.keywords.length) return 'Anahtar kelime yok: şehirdeki tüm yeni ilanlar taranır; profiline uyanlar listene eklenir.';
  return source.keyword_mode === 'query' ? 'Anahtar kelimeler sitenin aramasında kullanılır.' : 'Site anahtar kelimeli aramaya izin vermediği için şehir sayfası taranır, ilanlar anahtar kelimeyle süzülür.';
}
