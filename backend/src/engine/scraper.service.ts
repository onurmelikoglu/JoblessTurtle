import { Injectable, Logger } from '@nestjs/common';
import { Prisma, ScraperRun } from '@prisma/client';
import { env } from '../common/env';
import { ScraperHealth, ScraperRunState, ScraperRunView, ScraperSourceStatus, ScraperStatus } from '../contracts/scrapers';
import { ServerShape } from '../contracts/wire';
import { AppError, errorMessage } from '../common/errors';
import { OutboxService } from '../common/outbox.service';
import { PrismaService } from '../common/prisma.service';
import { listingExternalId, normalizeListingUrl } from '../domain/job-search';
import { CardRejection, cityKeysOf, isConfidentialCompany, listingInCities, ScrapedListing } from '../domain/scraped-jobs';
import {
  applyScraperConfigPatch,
  isScraperSource,
  resolveScraperConfig,
  SCRAPER_LABELS,
  SCRAPER_SOURCES,
  ScraperConfig,
  ScraperSource,
  sourceTargets,
  WORKSPACE_SOURCE_KIND,
} from '../domain/scraper-config';
import { FoundListing, JobSearchService } from './job-search.service';
import { NotifyService } from './notify.service';
import { defaultFetcher, ScraperHttpClient } from './scrapers/http-client';
import { RateLimiter, realSleep, Sleep } from './scrapers/rate-limiter';
import { SCRAPERS } from './scrapers/registry';
import { ScrapedJobRepository, UpsertOutcome } from './scrapers/scraped-job.repository';
import { PageContext, PageFetcher, RunError, ScrapeError, STOPPING_ERRORS } from './scrapers/types';

const CONFIG_KEY = 'scraper:config';
const ACTIVE_STATES = ['queued', 'running'];
const STOPPED_STATES = ['blocked', 'rate_limited'];
const MAX_ERRORS_KEPT = 50;
const MAX_REQUEST_CITIES = 30;
const MAX_REQUEST_KEYWORDS = 20;
const MAX_REQUEST_PAGES = 10;
const HOUR_MS = 3600_000;

export type RunTrigger = 'schedule' | 'manual' | 'api';

export interface RunRequest {
  source: ScraperSource;
  cities?: string[];
  keywords?: string[];
  max_pages?: number;
  trigger?: RunTrigger;
  requestedById?: string | null;
}

/** Çalışma kaydının dışarıya açık biçimi. */
export function toPublicRun(run: ScraperRun): ServerShape<ScraperRunView> {
  return {
    id: run.id,
    source: run.source,
    trigger: run.trigger,
    state: run.state as ScraperRunState,
    cities: run.cities,
    keywords: run.keywords,
    max_pages: run.maxPages,
    pages_visited: run.pagesVisited,
    pages_failed: run.pagesFailed,
    listings_found: run.listingsFound,
    listings_new: run.listingsNew,
    listings_updated: run.listingsUpdated,
    duplicates: run.duplicates,
    forwarded: run.forwarded,
    error_summary: run.errorSummary,
    errors: run.errors as unknown as RunError[],
    queued_at: run.queuedAt,
    started_at: run.startedAt,
    finished_at: run.finishedAt,
    duration_ms: run.startedAt && run.finishedAt ? run.finishedAt.getTime() - run.startedAt.getTime() : null,
  };
}

export type PublicRun = ServerShape<ScraperRunView>;

/** Yöneticiye bildirilen sorun: sitenin engellemesi, hız sınırı ya da sayfa düzeninin değişmesi. */
function problemOf(run: Pick<ScraperRun, 'state' | 'errors'>): 'blocked' | 'rate_limited' | 'selector' | null {
  if (run.state === 'blocked' || run.state === 'rate_limited') return run.state;
  return ((run.errors ?? []) as unknown as RunError[]).some((e) => e.kind === 'selector') ? 'selector' : null;
}

const PROBLEM_TITLE = { blocked: 'erişimi engelledi', rate_limited: 'istek sınırına takıldı', selector: 'sayfa düzeni değişmiş olabilir' } as const;

class RunTally {
  pagesVisited = 0;
  pagesFailed = 0;
  readonly outcomes: Record<UpsertOutcome, number> = { new: 0, repost: 0, updated: 0, seen: 0 };
  readonly errors: RunError[] = [];
  readonly rejected: Partial<Record<CardRejection, number>> = {};
  readonly ids = new Set<string>();
  readonly seen: ScrapedListing[] = [];
  readonly toForward: ScrapedListing[] = [];
  stop: ScrapeError | null = null;

  error(e: { kind: RunError['kind']; message: string; status?: number; url?: string }, ctx?: PageContext) {
    if (this.errors.length >= MAX_ERRORS_KEPT) return;
    this.errors.push({ kind: e.kind, message: e.message, status: e.status, url: e.url ?? ctx?.url, city: ctx?.target.city, keyword: ctx?.target.keyword, page: ctx?.page, at: new Date().toISOString() });
  }
}

/**
 * İlan sitesi taraması: çalışmayı açar (aynı site için ikinci çalışma açılmaz), sayfaları siteye özel tarayıcıyla dolaşır,
 * ilanları ortak kayda tekilleştirerek yazar, arama profiline uyan yeni ilanları çalışma alanlarına aktarır. Engel
 * (403/CAPTCHA) görülünce o sitenin taraması durur, yöneticiye bildirilir ve site bir süre zamanlamadan çıkar; diğer
 * sitenin çalışması etkilenmez. Engel aşılmaya çalışılmaz ve engelli tarama başarılı gösterilmez.
 */
@Injectable()
export class ScraperService {
  private readonly logger = new Logger('Scraper');
  /** Ağ katmanı ve bekleme; testlerde değiştirilir. */
  fetcher: PageFetcher = defaultFetcher;
  sleep: Sleep = realSleep;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: ScrapedJobRepository,
    private readonly outbox: OutboxService,
    private readonly notify: NotifyService,
    private readonly jobSearch: JobSearchService,
  ) {}

  // ───────────── Ayar ─────────────

  async config(): Promise<ScraperConfig> {
    const kv = await this.prisma.keyValue.findUnique({ where: { key: CONFIG_KEY } });
    return resolveScraperConfig(kv?.value);
  }

  async updateConfig(patch: unknown): Promise<ScraperConfig> {
    const result = applyScraperConfigPatch(await this.config(), patch);
    if ('errors' in result) throw new AppError(400, 'SCRAPER_CONFIG_INVALID', 'Tarama ayarı geçersiz', result.errors);
    for (const source of SCRAPER_SOURCES) {
      if (result.config.sources[source].keyword_mode === 'query' && !SCRAPERS[source].supportsKeywordQuery)
        throw new AppError(400, 'SCRAPER_CONFIG_INVALID', `${SCRAPER_LABELS[source]} anahtar kelimeli arama adresi doğrulanamadı (bot koruması); keyword_mode "local_filter" olmalı`);
    }
    const value = result.config as unknown as Prisma.InputJsonValue;
    await this.prisma.keyValue.upsert({ where: { key: CONFIG_KEY }, create: { key: CONFIG_KEY, value }, update: { value } });
    return result.config;
  }

  // ───────────── Çalışma açma ─────────────

  /**
   * Çalışmayı açar. Aynı site için sırada ya da çalışan bir çalışma varsa yenisi açılmaz, mevcut olan döner; kontrol
   * ve ekleme Postgres danışma kilidi altında yapıldığı için API, zamanlayıcı ve birden çok worker yarışamaz.
   */
  private async createRun(req: RunRequest): Promise<{ run: ScraperRun; created: boolean }> {
    if (!isScraperSource(req.source)) throw new AppError(400, 'SCRAPER_UNKNOWN', `Bilinmeyen site: ${String(req.source)}`);
    const config = await this.config();
    const defaults = sourceTargets(config, req.source);
    const cities = [...new Set((req.cities ?? defaults.cities).map((c) => c.trim()).filter(Boolean))].slice(0, MAX_REQUEST_CITIES);
    const keywords = [...new Set((req.keywords ?? defaults.keywords).map((k) => k.trim()).filter(Boolean))].slice(0, MAX_REQUEST_KEYWORDS);
    if (!cities.length) throw new AppError(400, 'SCRAPER_NO_CITY', 'En az bir şehir gerekli');
    const maxPages = Math.min(Math.max(Math.trunc(req.max_pages ?? config.sources[req.source].max_pages), 1), MAX_REQUEST_PAGES);
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`scraper-run:${req.source}`}))`;
      const active = await tx.scraperRun.findFirst({ where: { source: req.source, state: { in: ACTIVE_STATES } }, orderBy: { queuedAt: 'desc' } });
      if (active) return { run: active, created: false };
      const run = await tx.scraperRun.create({ data: { source: req.source, trigger: req.trigger ?? 'manual', cities, keywords, maxPages, requestedById: req.requestedById ?? null } });
      return { run, created: true };
    });
  }

  /** API ve zamanlayıcı: çalışmayı kuyruğa alır, beklemez. Durum çalışma kimliğiyle sorgulanır. */
  async enqueue(req: RunRequest): Promise<{ run: ScraperRun; created: boolean }> {
    this.assertEnabled();
    const result = await this.createRun(req);
    if (result.created) await this.outbox.emit({ eventType: 'scraper.run', aggregateId: result.run.id, dedupKey: `scraper-run:${result.run.id}` });
    return result;
  }

  /**
   * Başka servislerin doğrudan çağırdığı yol: çalışmayı açar, bu süreçte yürütür ve sonucunu döndürür.
   * await scraper.run({ source: 'kariyer_net', cities: ['İstanbul', 'Kocaeli'], keywords: ['Flutter Developer'], max_pages: 5 })
   */
  async run(req: RunRequest): Promise<PublicRun & { already_running: boolean }> {
    this.assertEnabled();
    const { run, created } = await this.createRun({ ...req, trigger: req.trigger ?? 'api' });
    if (!created) return { ...toPublicRun(run), already_running: true };
    return { ...toPublicRun(await this.execute(run.id)), already_running: false };
  }

  private assertEnabled() {
    if (!env().SCRAPERS_ENABLED) throw new AppError(409, 'SCRAPERS_DISABLED', 'İlan sitesi taraması sunucuda kapalı (SCRAPERS_ENABLED=false)');
  }

  // ───────────── Yürütme ─────────────

  /** Worker'da çalışır. Çalışma yalnızca "queued" iken sahiplenilir; aynı iş iki kez teslim edilse de bir kez yürür. */
  async execute(runId: string): Promise<ScraperRun> {
    const claimed = await this.prisma.scraperRun.updateMany({ where: { id: runId, state: 'queued' }, data: { state: 'running', startedAt: new Date() } });
    const run = await this.prisma.scraperRun.findUniqueOrThrow({ where: { id: runId } });
    if (!claimed.count) return run;
    if (!isScraperSource(run.source)) return this.finish(run, { state: 'failed', errorSummary: `Bilinmeyen site: ${run.source}` });
    const config = await this.config();
    if (!env().SCRAPERS_ENABLED || !config.enabled) return this.finish(run, { state: 'skipped', errorSummary: 'Tarama ayarlardan kapalı' });
    if (run.trigger === 'schedule' && !config.sources[run.source].enabled) return this.finish(run, { state: 'skipped', errorSummary: `${SCRAPER_LABELS[run.source]} taraması kapalı` });

    const source = run.source;
    const scraper = SCRAPERS[source];
    const own = config.sources[source];
    const tally = new RunTally();
    const client = new ScraperHttpClient({
      userAgent: env().HTTP_USER_AGENT,
      maxRetries: config.max_retries,
      retryBaseMs: config.retry_base_ms,
      maxRetryAfterSeconds: config.max_retry_after_seconds,
      limiter: new RateLimiter(own.request_delay_ms, this.sleep),
      blockMarkers: scraper.blockMarkers,
      fetcher: this.fetcher,
      sleep: this.sleep,
    });
    this.logger.log(`${scraper.label} taraması başladı (${run.id}): ${run.cities.join(', ')}${run.keywords.length ? ` · ${run.keywords.join(', ')}` : ''} · en çok ${run.maxPages} sayfa`);
    let crash: unknown = null;
    try {
      await scraper.collect(
        client,
        { cities: run.cities, keywords: run.keywords, keywordMode: own.keyword_mode, maxPages: run.maxPages, concurrency: own.concurrency, now: new Date() },
        {
          pageDone: async (listings) => {
            tally.pagesVisited++;
            for (const listing of listings) {
              if (tally.ids.has(listing.externalId)) continue;
              tally.ids.add(listing.externalId);
              const { outcome } = await this.jobs.upsert(listing, run.id, new Date());
              tally.outcomes[outcome]++;
              tally.seen.push(listing);
              if (outcome === 'new' || (!config.notify_only_new && outcome === 'updated')) tally.toForward.push(listing);
            }
          },
          pageFailed: (error, ctx) => {
            tally.pagesFailed++;
            tally.error({ kind: error.kind, message: error.message, status: error.detail.status, url: error.detail.url }, ctx);
            this.logger.warn(`${scraper.label} [${error.kind}] ${ctx.target.city}${ctx.target.keyword ? `/${ctx.target.keyword}` : ''} s.${ctx.page}: ${error.message}`);
            if (STOPPING_ERRORS.includes(error.kind)) tally.stop ??= error;
          },
          cardRejected: (reason) => {
            tally.rejected[reason] = (tally.rejected[reason] ?? 0) + 1;
          },
          stopped: () => tally.stop !== null,
        },
      );
    } catch (e) {
      crash = e;
      tally.error({ kind: 'parse', message: `Beklenmeyen hata: ${errorMessage(e)}` });
      this.logger.error(`${scraper.label} taraması beklenmedik biçimde durdu: ${errorMessage(e)}`);
    }
    const rejectedCards = Object.entries(tally.rejected);
    if (rejectedCards.length) tally.error({ kind: 'parse', message: `Zorunlu alanı okunamayan kartlar atlandı: ${rejectedCards.map(([reason, n]) => `${reason} ×${n}`).join(', ')}` });

    const state = tally.stop
      ? (tally.stop.kind as 'blocked' | 'rate_limited')
      : crash || (!tally.pagesVisited && tally.pagesFailed)
        ? 'failed'
        : tally.pagesFailed
          ? 'partial'
          : 'succeeded';
    const now = new Date();
    if (state === 'succeeded' || state === 'partial') await this.jobs.markStale(source, now, config);
    let forwarded = 0;
    if (config.forward_to_workspaces && tally.seen.length) {
      try {
        forwarded = await this.forward(run, source, tally.toForward, tally.seen, now);
      } catch (e) {
        tally.error({ kind: 'forward', message: `Çalışma alanlarına aktarılamadı: ${errorMessage(e)}` });
        this.logger.warn(`${scraper.label} ilanları çalışma alanlarına aktarılamadı: ${errorMessage(e)}`);
      }
    }
    const finished = await this.finish(run, {
      state,
      pagesVisited: tally.pagesVisited,
      pagesFailed: tally.pagesFailed,
      listingsFound: tally.ids.size,
      listingsNew: tally.outcomes.new,
      listingsUpdated: tally.outcomes.updated,
      duplicates: tally.outcomes.repost,
      forwarded,
      errors: tally.errors as unknown as Prisma.InputJsonValue,
      errorSummary: tally.stop?.message ?? summarizeErrors(tally.errors),
    });
    this.logger.log(
      `${scraper.label} taraması bitti (${run.id}): ${state} · ${tally.pagesVisited} sayfa (${tally.pagesFailed} hatalı) · ${tally.ids.size} ilan, ${tally.outcomes.new} yeni, ${tally.outcomes.updated} güncellenen · ${client.requests} istek`,
    );
    await this.reportProblem(finished).catch((e) => this.logger.warn(`Tarama bildirimi gönderilemedi: ${errorMessage(e)}`));
    return finished;
  }

  private finish(run: ScraperRun, data: Prisma.ScraperRunUpdateInput & { state: string }) {
    return this.prisma.scraperRun.update({ where: { id: run.id }, data: { ...data, finishedAt: new Date() } });
  }

  /**
   * Görülen ilanların çalışma alanındaki kayıtları "hâlâ yayında" diye tazelenir (süresi dolan kontrolü bunlara
   * dokunmasın); yeni ilanlar şehir seçimine uyan her etkin arama profiline verilir. Unvan ve uzaktan/yurt dışı süzgeci,
   * tekilleştirme, firma keşfi ve bildirim ilan aramasıyla aynı yoldan (JobSearchService.applyListings) geçer. Adı gizli
   * firmanın ilanı aktarılmaz: çalışma alanında "Gizli Firma" adında bir firma oluşurdu.
   */
  private async forward(run: ScraperRun, source: ScraperSource, fresh: ScrapedListing[], seen: ScrapedListing[], now: Date): Promise<number> {
    const kind = WORKSPACE_SOURCE_KIND[source];
    fresh = fresh.filter((l) => !isConfidentialCompany(l.companyName));
    const seenIds = seen.map((l) => normalizeListingUrl(l.jobUrl)).filter((u): u is string => !!u).map(listingExternalId);
    if (seenIds.length) await this.prisma.jobListing.updateMany({ where: { source: { kind }, externalId: { in: seenIds }, status: { in: ['open', 'unknown'] } }, data: { lastSeenAt: now } });
    if (!fresh.length) return 0;
    const profiles = await this.prisma.searchProfile.findMany({ where: { active: true }, include: { candidate: { select: { city: true } } }, orderBy: { createdAt: 'asc' } });
    let added = 0;
    for (const profile of profiles) {
      const cities = cityKeysOf(profile.candidate.city ?? profile.city);
      const listings = fresh.filter((l) => listingInCities(l, cities)).map((l) => toFoundListing(l));
      if (!listings.length) continue;
      const stats = await this.jobSearch.applyListings(profile, listings, `scrape-${run.id}-${profile.id}`, { sourceKind: kind, announced: true, origin: `${SCRAPER_LABELS[source]} taraması` });
      added += stats.fresh;
    }
    return added;
  }

  /** Engel, hız sınırı ya da düzen değişikliği yöneticilere bir kez bildirilir; sorun sürdükçe her çalışmada tekrarlanmaz. */
  private async reportProblem(run: ScraperRun) {
    const problem = problemOf(run);
    if (!problem || !isScraperSource(run.source)) return;
    const previous = await this.prisma.scraperRun.findFirst({ where: { source: run.source, id: { not: run.id }, finishedAt: { not: null }, state: { notIn: ['skipped', ...ACTIVE_STATES] } }, orderBy: { finishedAt: 'desc' } });
    if (previous && problemOf(previous) === problem) return;
    const admins = await this.prisma.user.findMany({ where: { isAdmin: true }, select: { memberships: { orderBy: { createdAt: 'asc' }, take: 1, select: { workspaceId: true } } } });
    const workspaces = [...new Set(admins.flatMap((a) => a.memberships.map((m) => m.workspaceId)))];
    const label = SCRAPER_LABELS[run.source];
    for (const workspaceId of workspaces) {
      await this.notify.notify(workspaceId, `scraper-problem:${run.id}`, {
        type: 'source_blocked',
        title: `${label} taraması: ${PROBLEM_TITLE[problem]}`,
        body: `${run.errorSummary ?? ''}${problem === 'selector' ? '' : ' Tarama durduruldu; engel aşılmaya çalışılmaz.'}`.trim(),
        link: '/profile',
      });
    }
  }

  // ───────────── Zamanlama ─────────────

  /** Sitenin sıradaki otomatik tarama zamanı: son çalışmadan aralık kadar sonra; engel ya da hız sınırından sonra bekleme süresi kadar. */
  async nextRunAt(source: ScraperSource, config: ScraperConfig): Promise<Date> {
    const last = await this.prisma.scraperRun.findFirst({ where: { source, state: { not: 'skipped' } }, orderBy: { queuedAt: 'desc' } });
    if (!last) return new Date(0);
    const byInterval = last.queuedAt.getTime() + config.sources[source].interval_hours * HOUR_MS;
    const cooldown = STOPPED_STATES.includes(last.state) ? (last.finishedAt ?? last.queuedAt).getTime() + config.block_cooldown_hours * HOUR_MS : 0;
    return new Date(Math.max(byInterval, cooldown));
  }

  /** Zamanlayıcı turu (worker, tek lider): süresi gelen siteler için çalışma açar; takılı kalan çalışmaları kapatır. */
  async scheduleDue(now = new Date()): Promise<{ queued: string[] }> {
    if (!env().SCRAPERS_ENABLED) return { queued: [] };
    const config = await this.config();
    await this.reapStuck(now, config);
    if (!config.enabled) return { queued: [] };
    const queued: string[] = [];
    for (const source of SCRAPER_SOURCES) {
      if (!config.sources[source].enabled || (await this.nextRunAt(source, config)) > now) continue;
      const { created } = await this.enqueue({ source, trigger: 'schedule' });
      if (created) queued.push(source);
    }
    return { queued };
  }

  /** Worker durduğu ya da tarama takıldığı için zaman aşımını geçen çalışmalar başarısız sayılır; site yeniden zamanlanabilir. */
  async reapStuck(now: Date, config: ScraperConfig) {
    const before = new Date(now.getTime() - config.run_timeout_minutes * 60_000);
    const stuck = await this.prisma.scraperRun.updateMany({
      where: { OR: [{ state: 'running', startedAt: { lt: before } }, { state: 'queued', queuedAt: { lt: before } }] },
      data: { state: 'failed', finishedAt: now, errorSummary: `Zaman aşımı: ${config.run_timeout_minutes} dakikada tamamlanmadı (worker durmuş ya da tarama takılmış olabilir)` },
    });
    return stuck.count;
  }

  // ───────────── Sorgular ─────────────

  async status(): Promise<ServerShape<ScraperStatus>> {
    const config = await this.config();
    const since = new Date(Date.now() - 24 * HOUR_MS);
    const sources: ServerShape<ScraperSourceStatus>[] = [];
    for (const source of SCRAPER_SOURCES) {
      const own = config.sources[source];
      const [last, active, activeJobs, newJobs] = await Promise.all([
        this.prisma.scraperRun.findFirst({ where: { source, finishedAt: { not: null } }, orderBy: { finishedAt: 'desc' } }),
        this.prisma.scraperRun.findFirst({ where: { source, state: { in: ACTIVE_STATES } }, orderBy: { queuedAt: 'desc' } }),
        this.prisma.scrapedJob.count({ where: { source, status: 'active', duplicateOfId: null } }),
        this.prisma.scrapedJob.count({ where: { source, firstSeenAt: { gte: since }, duplicateOfId: null } }),
      ]);
      const targets = sourceTargets(config, source);
      sources.push({
        source,
        label: SCRAPER_LABELS[source],
        enabled: config.enabled && own.enabled,
        interval_hours: own.interval_hours,
        max_pages: own.max_pages,
        keyword_mode: SCRAPERS[source].keywordModeOf(own.keyword_mode),
        cities: targets.cities,
        keywords: targets.keywords,
        health: healthOf(last),
        last_run: last ? toPublicRun(last) : null,
        active_run: active ? toPublicRun(active) : null,
        next_run_at: config.enabled && own.enabled && !active ? await this.nextRunAt(source, config) : null,
        active_jobs: activeJobs,
        new_jobs_24h: newJobs,
      });
    }
    return { enabled: env().SCRAPERS_ENABLED && config.enabled, server_enabled: env().SCRAPERS_ENABLED, sources };
  }

  async history(q: { source?: string; state?: string; cursor?: string; limit: number }) {
    const where: Prisma.ScraperRunWhereInput = { ...(q.source ? { source: q.source } : {}), ...(q.state ? { state: q.state } : {}) };
    const rows = await this.prisma.scraperRun.findMany({ where, orderBy: [{ queuedAt: 'desc' }, { id: 'desc' }], take: q.limit + 1, ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}) });
    const hasMore = rows.length > q.limit;
    const items = hasMore ? rows.slice(0, q.limit) : rows;
    return { items: items.map(toPublicRun), next_cursor: hasMore ? items[items.length - 1].id : null };
  }

  async runById(id: string) {
    const run = await this.prisma.scraperRun.findUnique({ where: { id } });
    if (!run) throw new AppError(404, 'NOT_FOUND', 'Tarama çalışması bulunamadı');
    return toPublicRun(run);
  }
}

/** Son biten çalışmaya göre sitenin durumu: ok, partial (bazı sayfalar alınamadı), blocked, rate_limited, failed, never. */
function healthOf(last: ScraperRun | null): ScraperHealth {
  if (!last) return 'never';
  if (last.state === 'succeeded') return 'ok';
  if (last.state === 'skipped') return 'disabled';
  return last.state as ScraperHealth;
}

function summarizeErrors(errors: RunError[]): string | null {
  if (!errors.length) return null;
  const byKind = new Map<string, number>();
  for (const e of errors) byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + 1);
  return `${[...byKind].map(([kind, n]) => `${kind} ×${n}`).join(', ')} — ilk hata: ${errors[0].message}`;
}

function toFoundListing(l: ScrapedListing): FoundListing {
  return {
    title: l.jobTitle,
    company: l.companyName,
    location: l.district ? `${l.city} - ${l.district}` : l.city,
    workMode: l.workMode ?? 'unknown',
    url: l.jobUrl,
    platform: SCRAPER_LABELS[l.source],
    postedAt: l.publishedAt?.toISOString() ?? null,
  };
}
