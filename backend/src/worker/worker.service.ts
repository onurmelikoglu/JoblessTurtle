import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { OutboxEvent, Prisma } from '@prisma/client';
import { Job, Queue, Worker } from 'bullmq';
import { promises as fs } from 'fs';
import Redis from 'ioredis';
import * as path from 'path';
import { sha256 } from '../common/crypto';
import { env } from '../common/env';
import { OutboxService } from '../common/outbox.service';
import { PrismaService } from '../common/prisma.service';
import { StorageService } from '../common/storage.service';
import { istanbulDay, istanbulNow } from '../common/time';
import { ActivityBucket, ActivityCounts, activityOfQueueJob } from '../domain/activity';
import { AiClass } from '../domain/ai-budget';
import { applyStaleness } from '../domain/listing-status';
import { ActivityService, DAILY_DISCOVERY_HOUR, PREDRAFT_EVERY_MS } from '../engine/activity.service';
import { appliedCompanyJobNotice, isFreshListing } from '../domain/applied-companies';
import { AddressBookService } from '../engine/address-book.service';
import { AppliedCompaniesService } from '../engine/applied-companies.service';
import { withAiClass } from '../engine/ai/ai-context';
import { AiService, AiSettings, DEFAULT_AI_SETTINGS, WORKER_HEARTBEAT_KEY } from '../engine/ai/ai.service';
import { resetProviderCache } from '../engine/ai/providers';
import { UsageService } from '../common/usage.service';
import { AutomationService, predraftBudget } from '../engine/automation.service';
import { AutopilotService } from '../engine/autopilot.service';
import { CatalogService } from '../engine/catalog.service';
import { connectorFor } from '../engine/connectors/registry';
import { DraftingService } from '../engine/drafting.service';
import { EvaluationService } from '../engine/evaluation.service';
import { InboxService } from '../engine/inbox.service';
import { IngestService } from '../engine/ingest.service';
import { JobSearchService } from '../engine/job-search.service';
import { LearnedModelsService } from '../engine/learned-models.service';
import { notificationCutoff, NotifyService } from '../engine/notify.service';
import { pickSegments, REPORT_REFRESH_DAYS, ResearchService, SIZE_BATCH } from '../engine/research.service';
import { ScraperService } from '../engine/scraper.service';
import { CandidateFactsService } from '../engine/candidate-facts.service';
import { isLetterIntent, LETTER_INTENTS, LetterService } from '../engine/letter.service';
import { SendingService } from '../engine/sending.service';
import { TelegramService } from '../engine/telegram.service';

const DAILY_DISCOVERY_SEGMENTS = 2;

const BACKGROUND_PRIORITY = 10;
const BULK_USER_PRIORITY = 5;
const PAUSABLE_EVENTS = ['discovery.ai', 'research.company', 'research.details.bg', 'research.sizes', 'catalog.seed', 'jobs.plan', 'jobs.search', 'profile.expand_titles'];
const STOPPABLE_QUEUES: QueueName[] = ['research', 'collect'];
const INBOX_SYNC_EVERY_MS = 10 * 60_000;
const PREDRAFT_PRIORITY = 8;
const ACTIVITY_EVERY_MS = 10_000;
const ACTIVITY_SCAN_LIMIT = 2000;
const WORKSPACE_CACHE_LIMIT = 20_000;
const AI_REAPER_EVERY_MS = 10 * 60_000;
const ADDRESS_SETTLE_EVERY_MS = 6 * 3600_000;
const BACKFILL_CHECK_EVERY_MS = 3600_000;
/** Gece turunda çalışma alanı başına çalışan sayısı sorulan en fazla firma grubu (her grup tek yapay zekâ çağrısı). */
const NIGHTLY_SIZE_BATCHES = 10;
/** Gece turunda arama profili başına çalıştırılan ilan arama sorgusu (her biri tek yapay zekâ çağrısı). */
const NIGHTLY_JOB_QUERIES = 4;
const PROFILE_CHANGE_JOB_QUERIES = 3;
const JOB_RECHECK_EVERY_MS = 12 * 3600_000;
const AUTOPILOT_SWEEP_EVERY_MS = 6 * 3600_000;
const MODEL_TRAINING_EVERY_MS = 24 * 3600_000;
const NOTIFICATION_CLEANUP_EVERY_MS = 24 * 3600_000;
/** İlan sitesi taramasının zamanı her dakika kontrol edilir; sitelere istek yalnızca aralık dolunca atılır. */
const SCRAPER_CHECK_EVERY_MS = 60_000;
/** Kurulu sağlayıcı kontrolü komut çalıştırdığı için kalp atışından seyrek yapılır. */
const PROVIDER_CHECK_EVERY_MS = 10 * 60_000;
/** Gece turunda raporu yenilenen firma sayısı (her biri en az bir yapay zekâ çağrısı). */
const NIGHTLY_REPORT_REFRESH = 15;
const OPEN_OPPORTUNITY = { status: { notIn: ['dismissed', 'applied'] }, category: { not: 'excluded' } };
/**
 * Arka planda yapay zekâ kullanan işlerin öncelik sınıfı. Sınıf kapalıyken (günlük hak ya da abonelik limiti) iş
 * başlatılmaz; aksi halde şablon çıktısı ya da kullanıcıyı bekleyen görev üretirdi. Bu işler sonraki turda yeniden planlanır.
 */
const BACKGROUND_AI_CLASS: Record<string, AiClass> = { company: 'research', company_details: 'research', company_sizes: 'research', discovery: 'discovery', job_search: 'discovery', expand_titles: 'discovery', predraft: 'letters', letter_template: 'letters' };
const DRAIN_CLOCK_WAIT_MS = 200;

export const QUEUES = ['collect', 'research', 'interactive', 'evaluate', 'automation', 'send', 'reconcile', 'notify', 'inbox', 'scrape'] as const;
type QueueName = (typeof QUEUES)[number];

/**
 * Worker süreci: outbox dağıtıcı, BullMQ kuyrukları (collect, research, evaluate, automation/draft,
 * send, reconcile, notify), zamanlayıcı, Telegram long-polling ve canlı olay yayını.
 * API'den ayrı süreçtir; aynı backend imajından farklı komutla başlatılır.
 */
@Injectable()
export class WorkerService implements OnApplicationShutdown {
  private readonly logger = new Logger('Worker');
  private connection!: Redis;
  private publisher!: Redis;
  private queues = new Map<QueueName, Queue>();
  private workers: Worker[] = [];
  private timers: NodeJS.Timeout[] = [];
  private running = false;
  /** Test modu: işler BullMQ yerine doğrudan işlenir (gecikmeli işler atlanır). */
  private inline: { name: string; queue: QueueName; data: Record<string, unknown>; delay: number }[] | null = null;
  private readonly workspaceOfEntity = new Map<string, string | null>();
  private installedProviders: { at: number; value: Record<string, boolean> } = { at: 0, value: {} };

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly storage: StorageService,
    private readonly ingest: IngestService,
    private readonly evaluation: EvaluationService,
    private readonly automation: AutomationService,
    private readonly sending: SendingService,
    private readonly research: ResearchService,
    private readonly candidateFacts: CandidateFactsService,
    private readonly letters: LetterService,
    private readonly drafting: DraftingService,
    private readonly notify: NotifyService,
    private readonly telegram: TelegramService,
    private readonly ai: AiService,
    private readonly usage: UsageService,
    private readonly inbox: InboxService,
    private readonly activity: ActivityService,
    private readonly catalog: CatalogService,
    private readonly addressBook: AddressBookService,
    private readonly jobSearch: JobSearchService,
    private readonly autopilot: AutopilotService,
    private readonly models: LearnedModelsService,
    private readonly scraper: ScraperService,
    private readonly appliedCompanies: AppliedCompaniesService,
  ) {}

  async start(opts: { scheduler?: boolean; telegram?: boolean } = {}) {
    this.running = true;
    this.connection = new Redis(env().REDIS_URL, { maxRetriesPerRequest: null });
    this.publisher = new Redis(env().REDIS_URL, { maxRetriesPerRequest: null });
    const prefix = 'jt';
    for (const name of QUEUES) this.queues.set(name, new Queue(name, { connection: this.connection, prefix }));
    const concurrency: Record<QueueName, number> = { collect: 4, research: 2, interactive: 2, evaluate: 2, automation: 1, send: 2, reconcile: 1, notify: 4, inbox: 1, scrape: 2 };
    for (const name of QUEUES) {
      const w = new Worker(name, (job) => this.handle(name, job), { connection: this.connection, prefix, concurrency: concurrency[name] });
      w.on('failed', (job, err) => this.logger.warn(`${name} işi başarısız (${job?.id}): ${err.message}`));
      this.workers.push(w);
    }
    this.loop(() => this.dispatchOutbox(), 1000);
    if (opts.scheduler ?? env().SCHEDULER_ENABLED) this.loop(() => this.schedulerTick(), 30_000);
    this.loop(() => this.heartbeat(), 30_000);
    this.loop(() => this.publishActivity(), ACTIVITY_EVERY_MS);
    if ((opts.telegram ?? env().TELEGRAM_POLLING) && env().TELEGRAM_BOT_TOKEN) void this.telegramLoop();
    this.logger.log('Worker başlatıldı');
  }

  private loop(fn: () => Promise<unknown>, ms: number) {
    let busy = false;
    const tick = async () => {
      if (busy || !this.running) return;
      busy = true;
      try {
        await fn();
      } catch (e) {
        this.logger.error(`Döngü hatası: ${(e as Error).message}`);
      } finally {
        busy = false;
      }
    };
    void tick();
    this.timers.push(setInterval(tick, ms));
  }

  async onApplicationShutdown() {
    await this.stop();
  }

  async stop() {
    this.running = false;
    this.timers.forEach(clearInterval);
    await Promise.all(this.workers.map((w) => w.close()));
    await Promise.all([...this.queues.values()].map((q) => q.close()));
    this.connection?.disconnect();
    this.publisher?.disconnect();
  }

  enableInline() {
    this.inline = [];
    this.publisher = { publish: async () => 0, disconnect: () => undefined } as unknown as Redis;
  }

  /**
   * Test yardımcısı: outbox ve inline kuyruk boşalana kadar işler. Veritabanı saati uygulama saatinin gerisindeyse
   * az önce yazılan olay henüz "zamanı gelmiş" görünmez; böyle bir olay varken beklenir.
   */
  async drain(maxRounds = 50) {
    for (let i = 0; i < maxRounds; i++) {
      const n = await this.dispatchOutbox();
      const jobs = (this.inline ?? []).splice(0).filter((j) => j.delay <= 1000);
      for (const j of jobs) {
        try {
          await this.handle(j.queue, { name: j.name, data: j.data } as Job);
        } catch (e) {
          this.logger.warn(`inline ${j.queue} hata: ${(e as Error).message}`);
        }
      }
      if (n > 0 || jobs.length > 0) continue;
      const dueByAppClock = await this.prisma.outboxEvent.count({ where: { processingState: 'pending', availableAt: { lte: new Date() } } });
      if (!dueByAppClock) return;
      await new Promise((resolve) => setTimeout(resolve, DRAIN_CLOCK_WAIT_MS));
    }
  }

  private async enqueue(queue: QueueName, name: string, data: Record<string, unknown>, key: string, delayMs = 0, attempts = 3, priority?: number) {
    if (this.inline) {
      this.inline.push({ queue, name, data, delay: delayMs });
      return;
    }
    await this.queues.get(queue)!.add(name, data, {
      jobId: sha256(key).slice(0, 40),
      delay: Math.max(0, delayMs),
      attempts,
      ...(priority ? { priority } : {}),
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 7 * 86400 },
    });
  }

  private async publish(workspaceId: string | null | undefined, data: Record<string, unknown>) {
    if (!workspaceId) return;
    await this.publisher.publish(`events:${workspaceId}`, JSON.stringify({ ...data, at: new Date().toISOString() })).catch(() => undefined);
  }

  // ───────────── Outbox dağıtıcı ─────────────

  /** Birden çok worker güvenle çalışabilsin diye olaylar SKIP LOCKED ile sahiplenilir. */
  async dispatchOutbox(limit = 100) {
    const events = await this.prisma.$queryRaw<OutboxEvent[]>`
      UPDATE "OutboxEvent" SET "processingState" = 'processing', attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM "OutboxEvent"
        WHERE "processingState" = 'pending' AND "availableAt" <= now()
        ORDER BY "createdAt" ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *`;
    for (const e of events) {
      try {
        await this.route(e);
        await this.prisma.outboxEvent.update({ where: { id: e.id }, data: { processingState: 'processed', processedAt: new Date() } });
        await this.publish(e.workspaceId, { type: e.eventType, id: e.aggregateId });
      } catch (err) {
        const failed = e.attempts >= 5;
        await this.prisma.outboxEvent.update({
          where: { id: e.id },
          data: { processingState: failed ? 'failed' : 'pending', lastError: (err as Error).message.slice(0, 500), availableAt: new Date(Date.now() + 10_000 * e.attempts) },
        });
      }
    }
    return events.length;
  }

  private async route(e: OutboxEvent) {
    const p = (e.payload ?? {}) as Record<string, any>;
    if (PAUSABLE_EVENTS.includes(e.eventType) && !p.userTriggered && (await this.research.isPaused(e.workspaceId))) return;
    switch (e.eventType) {
      case 'search.stop':
        return this.stopWorkspaceJobs(e.aggregateId);
      case 'evaluate.profile':
        return this.enqueue('evaluate', 'profile', { searchProfileId: e.aggregateId }, e.dedupKey);
      case 'evaluate.company':
        return this.enqueue('evaluate', 'company', { companyId: e.aggregateId }, e.dedupKey);
      case 'opportunity.new':
      case 'opportunity.updated':
      case 'automation.policy_activated':
        return this.enqueue('automation', e.eventType, { id: e.aggregateId, workspaceId: e.workspaceId }, e.dedupKey);
      case 'home.prepare':
        return this.enqueue('interactive', 'home.prepare', { id: e.aggregateId, workspaceId: e.workspaceId, userId: p.userId ?? null, fresh: p.fresh === true }, e.dedupKey, 0, 1);
      case 'letters.generate':
        return this.enqueue('interactive', 'letter_template', { candidateId: e.aggregateId, intent: p.intent, userId: p.userId ?? null }, e.dedupKey, 0, 1);
      case 'company.lookup':
        return this.enqueue('interactive', 'company_lookup', { workspaceId: e.workspaceId, lookupId: e.aggregateId, query: p.query, actorId: p.actorId ?? null }, e.dedupKey, 0, 1);
      case 'draft.translate':
        return this.enqueue('interactive', 'draft_translate', { draftId: e.aggregateId, lang: p.lang, userId: p.userId ?? null }, e.dedupKey, 0, 1);
      case 'research.details':
        return this.enqueue('interactive', 'company_details', { companyId: e.aggregateId, actorId: p.actorId ?? null, deep: true, force: true }, e.dedupKey, 0, 1);
      case 'research.details.bulk':
        return this.enqueue('research', 'company_details', { companyId: e.aggregateId, actorId: p.actorId ?? null, deep: true, force: p.force === true, onlyIfMissing: p.onlyIfMissing === true }, e.dedupKey, 0, 1, BULK_USER_PRIORITY);
      case 'research.details.bg':
        return this.enqueue('research', 'company_details', { companyId: e.aggregateId, actorId: p.actorId ?? null }, e.dedupKey, 0, 1, BACKGROUND_PRIORITY);
      case 'home.apply':
        return this.enqueue('automation', 'home.apply', { id: e.aggregateId, workspaceId: e.workspaceId, userId: p.userId ?? null }, e.dedupKey, 0, 1);
      case 'inbox.sync':
        return this.enqueue('inbox', 'sync', { accountId: e.aggregateId }, e.dedupKey, 0, 1);
      case 'autopilot.inbound':
        return this.enqueue('inbox', 'autopilot', { messageId: e.aggregateId, workspaceId: e.workspaceId }, e.dedupKey, 0, 1);
      case 'autopilot.run':
        return this.enqueue('inbox', 'autopilot_run', { actionId: e.aggregateId, workspaceId: e.workspaceId, userId: p.userId }, e.dedupKey, 0, 1);
      case 'send.attempt':
        return this.enqueue('send', 'attempt', { attemptId: e.aggregateId }, e.dedupKey, e.availableAt.getTime() - Date.now(), 1);
      case 'scraper.run':
        return this.enqueue('scrape', 'run', { runId: e.aggregateId }, e.dedupKey, 0, 1);
      case 'collect.source':
        return this.enqueue('collect', 'source', { sourceId: e.aggregateId, trigger: p.trigger ?? 'manual' }, e.dedupKey, 0, 1);
      case 'collect.all': {
        const sources = await this.prisma.sourceConnector.findMany({ where: { workspaceId: e.workspaceId!, enabled: true, health: { not: 'blocked' } } });
        for (const s of sources) if (connectorFor(s.kind).accessMode !== 'manual') await this.enqueue('collect', 'source', { sourceId: s.id, trigger: 'manual' }, `${e.dedupKey}:${s.id}`, 0, 1);
        return;
      }
      case 'research.company':
        return this.enqueue('research', 'company', { companyId: e.aggregateId, actorId: p.actorId ?? null }, e.dedupKey, 0, 2);
      case 'research.sizes':
        return this.enqueue('research', 'company_sizes', { workspaceId: e.workspaceId, companyIds: p.companyIds ?? [], actorId: p.actorId ?? null }, e.dedupKey, 0, 1, p.userTriggered ? BULK_USER_PRIORITY : BACKGROUND_PRIORITY);
      case 'catalog.seed':
        return this.enqueue('research', 'catalog_seed', { searchProfileId: e.aggregateId }, e.dedupKey, 0, 1);
      case 'jobs.plan':
        return this.enqueue('research', 'job_plan', { workspaceId: e.workspaceId, searchProfileId: p.searchProfileId, count: p.count ?? PROFILE_CHANGE_JOB_QUERIES, actorId: p.actorId ?? null }, e.dedupKey, 0, 1);
      case 'jobs.search':
        return this.enqueue('research', 'job_search', { workspaceId: e.workspaceId, searchProfileId: e.aggregateId, queryKey: p.queryKey, focus: p.focus, actorId: p.actorId ?? null, interactive: !!p.focus && p.userTriggered === true }, e.dedupKey, 0, 1, p.userTriggered ? BULK_USER_PRIORITY : BACKGROUND_PRIORITY);
      case 'candidate.cv_uploaded':
        return this.enqueue('research', 'cv_facts', { candidateId: e.aggregateId }, e.dedupKey, 0, 1);
      case 'profile.expand_titles':
        return this.enqueue('research', 'expand_titles', { searchProfileId: e.aggregateId, actorId: p.actorId ?? null }, e.dedupKey, 0, 1);
      case 'discovery.ai':
        return this.enqueue('research', 'discovery', { workspaceId: e.workspaceId, searchProfileId: p.searchProfileId, limit: p.limit, actorId: p.actorId, allowManual: p.allowManual, focus: p.focus }, e.dedupKey, 0, 1);
      case 'ai.task.completed':
        return this.enqueue('research', 'ai_completed', { taskId: e.aggregateId }, e.dedupKey);
      case 'notify':
        return this.enqueue('notify', 'notify', { workspaceId: e.workspaceId, eventId: e.dedupKey, ...p }, e.dedupKey);
      case 'job.closed':
      case 'job.changed':
      case 'job.reopened':
      case 'draft.changed_while_queued':
        return this.enqueue('automation', e.eventType, { id: e.aggregateId, workspaceId: e.workspaceId, ...p }, e.dedupKey);
      case 'job.new':
        return;
      case 'storage.purge_candidate':
        await fs.rm(path.join(path.resolve(env().STORAGE_DIR), 'candidates', path.basename(e.aggregateId)), { recursive: true, force: true });
        return;
      default:
        this.logger.warn(`Bilinmeyen olay türü: ${e.eventType}`);
    }
  }

  // ───────────── İş işleyiciler ─────────────

  /** Kullanıcının ekranda beklediği işler "etkileşimli" sınıfta çalışır; yapay zekâ payı daralsa da en son onlar durur. */
  async handle(queue: QueueName, job: Job): Promise<unknown> {
    const interactive = queue === 'interactive' || (job.data as Record<string, any> | undefined)?.interactive === true;
    if (interactive) return (await withAiClass('interactive', () => this.process(queue, job))).value;
    const aiClass = queue === 'research' ? BACKGROUND_AI_CLASS[job.name] : undefined;
    if (aiClass) {
      const workspaceId = await this.jobWorkspace(job.data as Record<string, any>, this.workspaceOfEntity);
      if (workspaceId && !(await this.ai.classOpen(workspaceId, aiClass))) return { status: 'deferred', reason: 'ai_class_closed', aiClass };
    }
    return this.process(queue, job);
  }

  private async process(queue: QueueName, job: Job): Promise<unknown> {
    const d = job.data as Record<string, any>;
    switch (queue) {
      case 'collect':
        return this.ingest.runSource(d.sourceId, d.trigger ?? 'schedule');
      case 'evaluate':
        return job.name === 'profile' ? this.evaluation.evaluateProfile(d.searchProfileId) : this.evaluation.evaluateCompany(d.companyId);
      case 'research':
        if (job.name === 'company') return this.research.researchCompany(d.companyId, d.actorId);
        if (job.name === 'company_details') {
          if (d.onlyIfMissing && (await this.research.hasSendableContact(d.companyId))) return { status: 'skipped', reason: 'contact_found' };
          return this.research.findDetails(d.companyId, d.actorId, { deep: d.deep === true, force: d.force === true });
        }
        if (job.name === 'letter_template') {
          const candidate = await this.prisma.candidateProfile.findUnique({ where: { id: d.candidateId } });
          return candidate && isLetterIntent(d.intent) ? this.letters.generateTemplate(candidate, d.intent, d.userId) : null;
        }
        if (job.name === 'cv_facts') {
          const r = await this.candidateFacts.ensureFromCv(d.candidateId);
          if (r.status === 'updated') await this.queueMissingTemplates(d.candidateId);
          return r;
        }
        if (job.name === 'predraft') return this.automation.prepareFromHome(d.workspaceId, d.id, null).then((r) => (r ? { draftId: r.draft.id } : { action: 'skipped' }));
        if (job.name === 'expand_titles') {
          const expanded = await this.research.expandTitles(d.searchProfileId, d.actorId);
          if (expanded.added) await this.catalog.seedWorkspace(d.searchProfileId);
          return expanded;
        }
        if (job.name === 'company_sizes') return this.research.findSizes(d.workspaceId, d.companyIds, d.actorId);
        if (job.name === 'catalog_seed') return this.catalog.seedWorkspace(d.searchProfileId);
        if (job.name === 'job_plan') return this.jobSearch.plan(d.workspaceId, { count: d.count, searchProfileId: d.searchProfileId, force: true, actorId: d.actorId });
        if (job.name === 'job_search') return d.focus ? this.jobSearch.runFocus(d.workspaceId, d.focus, d.actorId) : this.jobSearch.runQuery(d.searchProfileId, d.queryKey, d.actorId);
        if (job.name === 'catalog_refresh') return this.refreshFromCatalog(d.workspaceId, d.seed === true);
        if (job.name === 'catalog_backfill') return this.catalog.backfill();
        if (job.name === 'discovery') return this.research.discover(d.workspaceId, { searchProfileId: d.searchProfileId, limit: d.limit, actorId: d.actorId, allowManual: d.allowManual, focus: d.focus });
        if (job.name === 'ai_completed') {
          await this.drafting.applyAiDraft(d.taskId);
          await this.research.applyCompletedTask(d.taskId);
          return;
        }
        return;
      case 'interactive':
        return this.handleInteractive(job.name, d);
      case 'automation':
        return this.handleAutomation(job.name, d);
      case 'send': {
        const r = await this.sending.processAttempt(d.attemptId);
        const a = await this.prisma.applicationAttempt.findUnique({ where: { id: d.attemptId }, select: { workspaceId: true, state: true } });
        await this.publish(a?.workspaceId, { type: 'application.state', id: d.attemptId, state: a?.state, result: r });
        return r;
      }
      case 'reconcile':
        return this.sending.reconcile();
      case 'scrape':
        return this.scraper.execute(d.runId);
      case 'inbox':
        if (job.name === 'autopilot') return this.autopilot.onInbound(d.messageId);
        if (job.name === 'autopilot_run') return this.autopilot.runApproved(d.actionId, d.userId);
        return this.inbox.syncAccount(d.accountId);
      case 'notify': {
        await this.notify.notify(d.workspaceId, d.eventId, { type: d.type, title: d.title, body: d.body, link: d.link, score: d.score });
        await this.publish(d.workspaceId, { type: 'notification', title: d.title });
        return;
      }
    }
  }

  private async handleInteractive(name: string, d: Record<string, any>) {
    switch (name) {
      case 'home.prepare':
        return this.automation.prepareFromHome(d.workspaceId, d.id, d.userId, d.fresh === true).then((r) => (r ? { draftId: r.draft.id } : { action: 'skipped' }));
      case 'letter_template': {
        const candidate = await this.prisma.candidateProfile.findUnique({ where: { id: d.candidateId } });
        return candidate && isLetterIntent(d.intent) ? this.letters.generateTemplate(candidate, d.intent, d.userId) : null;
      }
      case 'company_details':
        return this.research.findDetails(d.companyId, d.actorId, { deep: d.deep === true, force: d.force === true });
      case 'company_lookup':
        return this.research.lookupCompany(d.workspaceId, d.lookupId, d.query, d.actorId);
      case 'draft_translate':
        return this.drafting.translateDraft(d.draftId, d.lang === 'tr' ? 'tr' : 'en', d.userId);
      default:
        this.logger.warn(`Bilinmeyen etkileşimli iş: ${name}`);
        return null;
    }
  }

  private async handleAutomation(name: string, d: Record<string, any>) {
    switch (name) {
      case 'opportunity.new': {
        const opp = await this.prisma.opportunity.findUnique({ where: { id: d.id }, include: { company: true, job: { include: { listings: { select: { postedAt: true } } } } } });
        const applied = opp ? await this.appliedCompanies.matchOf(opp.workspaceId, opp.companyId) : null;
        if (opp && applied) {
          // Başvurulan firma Firmalar listesinde yer almaz: kriterlere uyan güncel ilanı yalnızca bilgi olarak bildirilir.
          if (['target_open', 'adjacent_open'].includes(opp.category) && opp.job && isFreshListing(opp.job.listings.map((l) => l.postedAt), new Date())) {
            await this.notify.notify(opp.workspaceId, `applied-company-job:${opp.id}`, {
              type: 'applied_company_job',
              ...appliedCompanyJobNotice({ jobTitle: opp.job.title, companyName: opp.company.name, appliedName: applied.name, appliedAt: applied.appliedAt }),
              link: `/applications?attempt=${applied.attemptId}`,
              score: opp.f,
            });
          }
          return { action: 'skipped', reason: 'company_applied' };
        }
        if (opp && ['target_open', 'adjacent_open'].includes(opp.category)) {
          await this.notify.notify(opp.workspaceId, `opp-new:${opp.id}`, {
            type: 'new_opportunity',
            title: `${opp.category === 'target_open' ? 'Yeni hedef ilan' : 'Yeni yakın rol'}: ${opp.job?.title ?? ''} — ${opp.company.name}`,
            body: `F: ${opp.f ?? '-'} · Q: ${opp.q ?? '-'} · Konum: ${opp.locationState}`,
            link: `/opportunities?id=${opp.id}`,
            score: opp.f,
          });
        }
        return this.automation.onOpportunity(d.id);
      }
      case 'opportunity.updated':
        return this.automation.onOpportunity(d.id);
      case 'home.prepare':
        return this.automation.prepareFromHome(d.workspaceId, d.id, d.userId, d.fresh === true).then((r) => (r ? { draftId: r.draft.id } : { action: 'skipped' }));
      case 'home.apply':
        return this.automation.applyFromHome(d.workspaceId, d.id, d.userId);
      case 'automation.policy_activated': {
        const policy = await this.prisma.automationPolicy.findUnique({ where: { id: d.id } });
        if (!policy?.active) return;
        const opps = await this.prisma.opportunity.findMany({ where: { searchProfileId: policy.searchProfileId, status: { in: ['new', 'reviewed'] }, category: { not: 'excluded' } }, select: { id: true }, take: 300 });
        for (const o of opps) await this.automation.onOpportunity(o.id);
        return { evaluated: opps.length };
      }
      case 'job.closed': {
        // Kapalı ilana ilan başvurusu gönderilmez: kuyruk durur, taslaklar incelemeye düşer.
        const attempts = await this.prisma.applicationAttempt.findMany({ where: { jobId: d.id, state: 'queued', intentType: 'job_application' } });
        for (const a of attempts) await this.sending.cancel(a.workspaceId, a.id, 'JOB_CLOSED', null);
        await this.prisma.applicationDraft.updateMany({ where: { jobId: d.id, intentType: 'job_application', status: { in: ['draft', 'needs_review'] } }, data: { status: 'needs_review', blockedReasons: { push: 'İlan kapandı — niyet başvurusu olarak yeniden değerlendirin' } } });
        const job = await this.prisma.job.findUnique({ where: { id: d.id }, include: { company: true } });
        if (job && (attempts.length || (await this.prisma.opportunity.count({ where: { jobId: job.id } })))) {
          await this.notify.notify(job.workspaceId, `job-closed:${job.id}:${job.openCycle}`, { type: 'job_closed', title: `İlan kapandı: ${job.title} — ${job.company.name}`, body: attempts.length ? `${attempts.length} bekleyen gönderim durduruldu.` : undefined, link: `/jobs/${job.id}` });
        }
        return;
      }
      case 'job.changed': {
        const drafts = await this.prisma.applicationDraft.findMany({ where: { jobId: d.id, status: 'draft' } });
        for (const dr of drafts) await this.prisma.applicationDraft.update({ where: { id: dr.id }, data: { status: 'needs_review', blockedReasons: { push: 'İlan içeriği değişti — taslağı gözden geçirin' } } });
        return;
      }
      case 'job.reopened': {
        const job = await this.prisma.job.findUnique({ where: { id: d.id }, include: { company: true } });
        if (!job) return;
        const applied = await this.prisma.applicationAttempt.count({ where: { jobId: job.id, state: { in: ['provider_accepted', 'replied', 'outcome_recorded'] } } });
        await this.notify.notify(job.workspaceId, `job-reopen:${job.id}:${job.openCycle}`, {
          type: 'job_reopened',
          title: `İlan yeniden açıldı: ${job.title} — ${job.company.name}`,
          body: applied ? 'Bu ilana daha önce başvurdunuz; yeniden gönderim yerine inceleme önerilir.' : undefined,
          link: `/jobs/${job.id}`,
        });
        return;
      }
      case 'draft.changed_while_queued': {
        const changed = await this.prisma.applicationDraft.findUnique({ where: { id: d.id }, select: { opportunityId: true } });
        return this.notify.notify(d.workspaceId, `draft-changed:${d.id}:${Date.now()}`, { type: 'draft_changed', title: 'Kuyruktaki taslak değişti', body: 'Onaylanan sürüm değiştiği için gönderim yapılmayacak; taslağı yeniden gönderin.', link: changed?.opportunityId ? `/opportunities?id=${changed.opportunityId}` : '/home' });
      }
    }
  }

  // ───────────── Zamanlayıcı ─────────────

  /** Tek lider: birden fazla worker varsa Redis kilidiyle yalnızca biri planlama yapar. */
  async schedulerTick(now = new Date()) {
    const lock = await this.connection.set('jt:scheduler:lock', String(process.pid), 'PX', 25_000, 'NX');
    if (!lock) return;
    await this.scheduleSources(now);
    await this.periodic('reconcile', 5 * 60_000, now, () => this.enqueue('reconcile', 'reconcile', {}, `reconcile:${Math.floor(now.getTime() / 300_000)}`, 0, 1));
    await this.periodic('followups', 10 * 60_000, now, () => this.automation.processFollowUps(now));
    await this.periodic('staleness', 30 * 60_000, now, () => this.markStale(now));
    await this.periodic('stuck-crawls', 10 * 60_000, now, () => this.ingest.closeStuckRuns(now));
    await this.periodic('predraft', PREDRAFT_EVERY_MS, now, () => this.schedulePredrafts(now));
    await this.periodic('ai-reaper', AI_REAPER_EVERY_MS, now, () => this.activity.reapStuckAiTasks(now));
    await this.periodic('inbox', INBOX_SYNC_EVERY_MS, now, () => this.scheduleInboxSync(now));
    await this.periodic('retention', 6 * 3600_000, now, () => this.retention(now));
    await this.periodic('notification-retention', NOTIFICATION_CLEANUP_EVERY_MS, now, () => this.cleanupNotifications(now));
    await this.periodic('address-settle', ADDRESS_SETTLE_EVERY_MS, now, () => this.addressBook.settle(now));
    await this.periodic('job-recheck', JOB_RECHECK_EVERY_MS, now, () => this.jobSearch.expireStale(now));
    await this.periodic('autopilot-sweep', AUTOPILOT_SWEEP_EVERY_MS, now, () => this.autopilot.sweep(undefined, now));
    await this.periodic('model-training', MODEL_TRAINING_EVERY_MS, now, () => this.models.train(now));
    await this.periodic('scrapers', SCRAPER_CHECK_EVERY_MS, now, () => this.scraper.scheduleDue(now));
    await this.periodic('title-normalization', BACKFILL_CHECK_EVERY_MS, now, () => this.ingest.renormalizeTitles());
    await this.periodic('catalog-backfill', BACKFILL_CHECK_EVERY_MS, now, async () => {
      if (!(await this.catalog.backfilled())) await this.enqueue('research', 'catalog_backfill', {}, `catalog-backfill:${Math.floor(now.getTime() / BACKFILL_CHECK_EVERY_MS)}`, 0, 1);
    });
    const t = istanbulNow(now);
    if (t.hour === env().DIGEST_HOUR) await this.daily('digest', now, async () => {
      const workspaces = await this.prisma.workspace.findMany({ select: { id: true } });
      for (const w of workspaces) await this.notify.dailyDigest(w.id, now);
    });
    if (t.hour === DAILY_DISCOVERY_HOUR) await this.daily('discovery', now, () => this.dailyDiscovery(now));
  }

  private async scheduleInboxSync(now: Date) {
    const slot = Math.floor(now.getTime() / INBOX_SYNC_EVERY_MS);
    for (const a of await this.inbox.syncableAccounts()) await this.enqueue('inbox', 'sync', { accountId: a.id }, `inbox:${a.id}:${slot}`, 0, 1);
  }

  private async periodic(key: string, everyMs: number, now: Date, fn: () => Promise<unknown>) {
    const kv = await this.prisma.keyValue.findUnique({ where: { key: `sched:${key}` } });
    const last = (kv?.value as any)?.at ? new Date((kv!.value as any).at).getTime() : 0;
    if (now.getTime() - last < everyMs) return;
    await this.prisma.keyValue.upsert({ where: { key: `sched:${key}` }, create: { key: `sched:${key}`, value: { at: now.toISOString() } }, update: { value: { at: now.toISOString() } } });
    await fn();
  }

  private async daily(key: string, now: Date, fn: () => Promise<unknown>) {
    const k = `sched:${key}:${istanbulDay(now)}`;
    try {
      await this.prisma.keyValue.create({ data: { key: k, value: { at: now.toISOString() } } });
    } catch {
      return; // bugün zaten çalıştı
    }
    await fn();
  }

  /**
   * Kaynak takibi: zamanlayıcı her tur uygun görevleri kontrol eder; bu her kaynağa her dakika istek
   * atıldığı anlamına gelmez. Aralık, kaynağın izin verdiği minimumun altına inmez; geri çekilme uygulanır.
   */
  async scheduleSources(now = new Date()) {
    const due = await this.prisma.sourceConnector.findMany({
      where: {
        enabled: true,
        health: { not: 'blocked' },
        accessMode: { not: 'manual' },
        OR: [{ nextRunAt: null }, { nextRunAt: { lte: now } }],
        AND: [{ OR: [{ backoffUntil: null }, { backoffUntil: { lte: now } }] }],
      },
      take: 200,
    });
    for (const s of due) {
      const interval = Math.max(s.intervalMinutes, s.minIntervalMinutes, 1);
      await this.prisma.sourceConnector.update({ where: { id: s.id }, data: { nextRunAt: new Date(now.getTime() + interval * 60_000) } });
      await this.enqueue('collect', 'source', { sourceId: s.id, trigger: 'schedule' }, `collect:${s.id}:${Math.floor(now.getTime() / 60_000)}`, 0, 1);
    }
    return due.length;
  }

  private async jobWorkspace(d: Record<string, any>, cache: Map<string, string | null>): Promise<string | null> {
    if (d.workspaceId) return d.workspaceId;
    const lookups: [string | undefined, () => Promise<{ workspaceId: string } | null>][] = [
      [d.companyId, () => this.prisma.company.findUnique({ where: { id: d.companyId }, select: { workspaceId: true } })],
      [d.candidateId, () => this.prisma.candidateProfile.findUnique({ where: { id: d.candidateId }, select: { workspaceId: true } })],
      [d.searchProfileId, () => this.prisma.searchProfile.findUnique({ where: { id: d.searchProfileId }, select: { workspaceId: true } })],
      [d.sourceId, () => this.prisma.sourceConnector.findUnique({ where: { id: d.sourceId }, select: { workspaceId: true } })],
      [d.attemptId, () => this.prisma.applicationAttempt.findUnique({ where: { id: d.attemptId }, select: { workspaceId: true } })],
      [d.accountId, () => this.prisma.mailAccount.findUnique({ where: { id: d.accountId }, select: { workspaceId: true } })],
      [d.draftId, () => this.prisma.applicationDraft.findUnique({ where: { id: d.draftId }, select: { workspaceId: true } })],
    ];
    for (const [id, find] of lookups) {
      if (!id) continue;
      if (!cache.has(id)) cache.set(id, (await find())?.workspaceId ?? null);
      return cache.get(id) ?? null;
    }
    return null;
  }

  /** Kullanıcı aramayı durdurduğunda çalışma alanının bekleyen araştırma ve tarama işlerini kuyruktan çıkarır; çalışan işler tamamlanır. */
  async stopWorkspaceJobs(workspaceId: string) {
    const cache = new Map<string, string | null>();
    let removed = 0;
    for (const name of STOPPABLE_QUEUES) {
      const queue = this.queues.get(name);
      if (!queue) continue;
      for (const job of await queue.getJobs(['waiting', 'prioritized', 'delayed'])) {
        if (!job || (await this.jobWorkspace(job.data as Record<string, any>, cache)) !== workspaceId) continue;
        await job.remove().then(() => removed++).catch(() => undefined);
      }
    }
    this.logger.log(`Arama durduruldu (${workspaceId}): ${removed} bekleyen iş iptal edildi`);
    return { removed };
  }

  private async queueMissingTemplates(candidateId: string) {
    const existing = await this.letters.templates(candidateId);
    for (const intent of LETTER_INTENTS) {
      if (existing[intent]) continue;
      await this.enqueue('research', 'letter_template', { candidateId, intent, userId: null }, `letters-auto:${candidateId}:${intent}:${Date.now()}`, 0, 1, PREDRAFT_PRIORITY);
    }
  }

  /** Mail adresi bilinen fırsatlar için yazıları arka planda hazırlar; kullanıcının etkileşimli işleri için AI payı ayrılır. */
  async schedulePredrafts(now: Date) {
    const policies = await this.prisma.automationPolicy.findMany({ where: { active: true }, orderBy: { createdAt: 'desc' } });
    const seen = new Set<string>();
    for (const policy of policies) {
      if (seen.has(policy.workspaceId)) continue;
      seen.add(policy.workspaceId);
      if (await this.research.isPaused(policy.workspaceId)) continue;
      const settings = await this.ai.settings(policy.workspaceId);
      const used = await this.usage.get(policy.workspaceId, 'ai:tasks', now);
      for (const id of await this.automation.predraftCandidates(policy, predraftBudget(settings.dailyTaskLimit, used))) {
        await this.enqueue('research', 'predraft', { workspaceId: policy.workspaceId, id }, `predraft:${id}`, 0, 1, PREDRAFT_PRIORITY);
      }
    }
  }

  private async markStale(now: Date) {
    // Kullanıcının işaretlediği veya yalnızca manuel/ikincil kaynaktan gelen ilanlar otomatik doğrulanamadığı için bayatlatılmaz.
    const jobs = await this.prisma.job.findMany({
      where: { status: 'open', NOT: { statusReason: 'user_marked' }, listings: { some: { isOfficial: true } } },
      select: { id: true, companyId: true, workspaceId: true, lastVerifiedAt: true },
    });
    for (const j of jobs) {
      if (applyStaleness('open', j.lastVerifiedAt, now) === 'stale') {
        await this.prisma.job.update({ where: { id: j.id }, data: { status: 'stale', statusReason: 'not_verified_72h' } });
        await this.outbox.emit({ workspaceId: j.workspaceId, eventType: 'evaluate.company', aggregateId: j.companyId, dedupKey: `eval-company:${j.companyId}:stale:${istanbulDay(now)}`, payload: {} });
      }
    }
  }

  /** Ortak katalogdaki yeni bilgiyi (adres, ofis, çalışan sayısı) çalışma alanına alır; seed açıksa profile uyan yeni firmaları da ekler. */
  private async refreshFromCatalog(workspaceId: string, seed: boolean) {
    const pulled = await this.catalog.pullWorkspace(workspaceId);
    if (!seed) return { pulled };
    const profiles = await this.prisma.searchProfile.findMany({ where: { workspaceId, active: true }, select: { id: true } });
    let created = 0;
    for (const p of profiles) created += (await this.catalog.seedWorkspace(p.id)).created;
    return { pulled, created };
  }

  private async dailyDiscovery(now: Date) {
    const workspaces = await this.prisma.workspace.findMany();
    for (const w of workspaces) {
      if (await this.research.isPaused(w.id)) continue;
      // Rapor yenileme: hiç araştırılmamış firmalar ve hâlâ başvurulabilecek fırsatı olan firmaların eskimiş raporları
      // (öncelik izleme listesi ve yüksek Q). Başvurulmuş ya da gizlenmiş firmanın raporu yenilenmez.
      const refreshBefore = new Date(now.getTime() - REPORT_REFRESH_DAYS * 86400_000);
      const stale = await this.prisma.company.findMany({
        where: { workspaceId: w.id, excluded: false, OR: [{ lastResearchedAt: null }, { lastResearchedAt: { lt: refreshBefore }, opportunities: { some: OPEN_OPPORTUNITY } }] },
        orderBy: [{ watch: 'desc' }, { qScore: { sort: 'desc', nulls: 'last' } }],
        take: NIGHTLY_REPORT_REFRESH,
      });
      for (const c of stale) await this.enqueue('research', 'company', { companyId: c.id }, `research:${c.id}:${istanbulDay(now)}`, 0, 1);
      // İletişim güncelliği: kaynağında doğrulanmış adresler yapay zekâsız yeniden teyit edilir; yalnızca doğrulanmış
      // adresi kalmayan ve henüz başvurulmamış firmalar için yeni arama yapılır.
      const reverified = await this.research.reverifyContacts(w.id, now);
      for (const cid of reverified.companyIds) await this.enqueue('research', 'company_details', { companyId: cid, actorId: null }, `research-details:${cid}:contact:${istanbulDay(now)}`, 0, 1, BACKGROUND_PRIORITY);
      // Unvan odaklı firma keşfi varsayılan açıktır; manuel köprüde her gün görev biriktirmemek için allowManual kapalı.
      const ai = { ...DEFAULT_AI_SETTINGS, ...((w.aiSettings ?? {}) as Partial<AiSettings>) };
      // Önce ortak hafıza (yapay zekâsız): başkalarının bulduğu adres ve firmalar alınır, kalan boşluk için arama yapılır.
      await this.enqueue('research', 'catalog_refresh', { workspaceId: w.id, seed: ai.dailyDiscovery !== false }, `catalog-refresh:${w.id}:${istanbulDay(now)}`, 0, 1);
      if (ai.dailyDiscovery !== false) {
        await this.jobSearch.plan(w.id, { count: NIGHTLY_JOB_QUERIES });
        const sizeTargets = await this.research.sizeCandidates(w.id, SIZE_BATCH * NIGHTLY_SIZE_BATCHES, now.getTime());
        for (let i = 0; i < sizeTargets.length; i += SIZE_BATCH) {
          await this.enqueue('research', 'company_sizes', { workspaceId: w.id, companyIds: sizeTargets.slice(i, i + SIZE_BATCH) }, `sizes:${w.id}:${istanbulDay(now)}:${i}`, 0, 1, BACKGROUND_PRIORITY);
        }
        const profiles = await this.prisma.searchProfile.findMany({ where: { workspaceId: w.id, active: true }, select: { id: true } });
        for (const p of profiles) {
          for (const focus of pickSegments(await this.research.segmentLog(p.id), { count: DAILY_DISCOVERY_SEGMENTS })) {
            await this.enqueue('research', 'discovery', { workspaceId: w.id, searchProfileId: p.id, limit: ai.discoveryLimit ?? 10, allowManual: false, focus }, `discovery:${p.id}:${istanbulDay(now)}:${focus}`, 0, 1);
          }
        }
      }
    }
  }

  /** Saklama süreleri: ham gözlem 30 gün, geçici dosya 24 saat, hata/log 90 gün. */
  /** Bildirimler 30 gün tutulur; daha eskiler her gün silinir (ilk tur deploy'dan hemen sonra çalışır). */
  async cleanupNotifications(now = new Date()) {
    const { count } = await this.prisma.notification.deleteMany({ where: { createdAt: { lt: notificationCutoff(now) } } });
    if (count) this.logger.log(`${count} eski bildirim silindi`);
    return count;
  }

  private async retention(now: Date) {
    const d = (days: number) => new Date(now.getTime() - days * 86400_000);
    await this.prisma.sourceObservation.deleteMany({ where: { fetchedAt: { lt: d(30) } } });
    await this.prisma.crawlRun.deleteMany({ where: { startedAt: { lt: d(90) } } });
    await this.prisma.outboxEvent.deleteMany({ where: { processingState: 'processed', processedAt: { lt: d(7) } } });
    await this.prisma.aiTask.updateMany({ where: { createdAt: { lt: d(30) } }, data: { rawOutput: null } });
    await this.prisma.webhookEvent.deleteMany({ where: { receivedAt: { lt: d(30) } } });
    const imports = await this.prisma.importJob.findMany({ where: { createdAt: { lt: d(1) } } });
    for (const i of imports) await this.storage.delete(i.objectKey).catch(() => undefined);
    await this.prisma.telegramLinkCode.deleteMany({ where: { expiresAt: { lt: d(1) } } });
  }

  /**
   * Arayüzün "şu an ne çalışıyor" bilgisini kuyruklardan üretir: çalışma alanı başına çalışan ve bekleyen iş sayıları.
   * Zamanı gelmemiş gönderimler kuyruk panelinde ayrıca göründüğü için sayılmaz.
   */
  private async publishActivity() {
    if (this.inline) return;
    if (this.workspaceOfEntity.size > WORKSPACE_CACHE_LIMIT) this.workspaceOfEntity.clear();
    const workspaces: Record<string, ActivityCounts> = {};
    const add = (workspaceId: string, bucket: ActivityBucket, field: 'running' | 'queued') => {
      const counts = (workspaces[workspaceId] ??= {});
      const entry = (counts[bucket] ??= { running: 0, queued: 0 });
      entry[field]++;
    };
    for (const [name, queue] of this.queues) {
      const waitingStates = name === 'send' ? (['waiting', 'prioritized'] as const) : (['waiting', 'prioritized', 'delayed'] as const);
      for (const [states, field] of [[['active'] as const, 'running'], [waitingStates, 'queued']] as const) {
        for (const job of await queue.getJobs([...states], 0, ACTIVITY_SCAN_LIMIT)) {
          if (!job) continue;
          const data = (job.data ?? {}) as Record<string, any>;
          const bucket = activityOfQueueJob(name, job.name, data);
          if (!bucket) continue;
          const workspaceId = await this.jobWorkspace(data, this.workspaceOfEntity);
          if (workspaceId) add(workspaceId, bucket, field);
        }
      }
    }
    await this.activity.saveSnapshot(workspaces);
  }

  private async heartbeat() {
    const counts: Record<string, unknown> = {};
    for (const [name, q] of this.queues) counts[name] = await q.getJobCounts('waiting', 'active', 'delayed', 'failed');
    const pendingOutbox = await this.prisma.outboxEvent.count({ where: { processingState: 'pending' } });
    // Arayüzden hesap bağlanınca ya da API anahtarı değişince seyrek kontrol beklenmeden tazelenir.
    const changedAt = await this.ai.providersChangedAt();
    if (changedAt > this.installedProviders.at) resetProviderCache();
    if (Date.now() - this.installedProviders.at > PROVIDER_CHECK_EVERY_MS || changedAt > this.installedProviders.at) {
      this.installedProviders = { at: Date.now(), value: await this.ai.installedProviders() };
      await this.ai.refreshCodexModels().catch((e) => this.logger.warn(`ChatGPT model listesi okunamadı: ${(e as Error).message}`));
    }
    const value = { at: new Date().toISOString(), pid: process.pid, queues: counts, pendingOutbox, providers: this.installedProviders.value } as Prisma.InputJsonValue;
    await this.prisma.keyValue.upsert({ where: { key: WORKER_HEARTBEAT_KEY }, create: { key: WORKER_HEARTBEAT_KEY, value }, update: { value } });
  }

  private async telegramLoop() {
    while (this.running) {
      try {
        await this.telegram.pollOnce();
      } catch (e) {
        this.logger.warn(`Telegram: ${(e as Error).message}`);
        await new Promise((r) => setTimeout(r, 15_000));
      }
    }
  }
}
