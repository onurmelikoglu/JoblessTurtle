import { Body, Controller, Get, HttpCode, Module, Param, Post, Put, Query } from '@nestjs/common';
import { z, ZodSchema } from 'zod';
import { AuditService } from '../../common/audit.service';
import { AdminOnly, Ctx, RequestContext } from '../../common/auth';
import { AppError } from '../../common/errors';
import { ZodPipe } from '../../common/zod.pipe';
import { toPublicJob } from '../../domain/scraped-jobs';
import { SCRAPER_SOURCES } from '../../domain/scraper-config';
import { ScraperService, toPublicRun } from '../../engine/scraper.service';
import { ScrapedJobRepository } from '../../engine/scrapers/scraped-job.repository';

const NEW_WINDOW_HOURS = 24;

const runSchema = z.object({
  source: z.enum([...SCRAPER_SOURCES, 'all']).default('all'),
  cities: z.array(z.string().trim().min(2).max(60)).min(1).max(30).optional(),
  keywords: z.array(z.string().trim().min(2).max(80)).max(20).optional(),
  max_pages: z.number().int().min(1).max(10).optional(),
});

const isoDate = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), 'ISO-8601 tarih bekleniyor')
  .transform((v) => new Date(v));
const flag = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');

const jobsQuery = z.object({
  source: z.enum(SCRAPER_SOURCES).optional(),
  city: z.string().max(60).optional(),
  company: z.string().max(120).optional(),
  title: z.string().max(120).optional(),
  status: z.enum(['active', 'missing', 'expired']).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  only_new: flag.optional(),
  since: isoDate.optional(),
  include_duplicates: flag.optional(),
  cursor: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
type JobsQuery = z.infer<typeof jobsQuery>;
/** Dönüştürülen alanlar (tarih, bayrak) yüzünden giriş ve çıkış tipi farklıdır; boru çıkış tipini verir. */
const jobsPipe = () => new ZodPipe<JobsQuery>(jobsQuery as unknown as ZodSchema<JobsQuery>);

const historyQuery = z.object({
  source: z.enum(SCRAPER_SOURCES).optional(),
  state: z.enum(['queued', 'running', 'succeeded', 'partial', 'blocked', 'rate_limited', 'failed', 'skipped']).optional(),
  cursor: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/**
 * İlan sitesi taraması API'si. Taramalar ve taranan ilanlar sunucu genelinde ortaktır: ayar ve tarama başlatma yalnızca
 * sunucu yöneticisine açıktır; sorgular her oturum açmış kullanıcıya açıktır. Tarama isteği bloklamaz: çalışma kuyruğa
 * alınır, kimliğiyle sorgulanır.
 */
@Controller('v1/scrapers')
export class ScrapersController {
  constructor(
    private readonly scraper: ScraperService,
    private readonly jobs: ScrapedJobRepository,
    private readonly audit: AuditService,
  ) {}

  @Post('run')
  @AdminOnly()
  @HttpCode(202)
  async run(@Ctx() ctx: RequestContext, @Body(new ZodPipe(runSchema)) body: z.infer<typeof runSchema>) {
    const sources = body.source === 'all' ? [...SCRAPER_SOURCES] : [body.source];
    const runs = [];
    for (const source of sources) {
      const { run, created } = await this.scraper.enqueue({ source, cities: body.cities, keywords: body.keywords, max_pages: body.max_pages, trigger: 'manual', requestedById: ctx.userId });
      runs.push({ ...toPublicRun(run), already_running: !created });
    }
    return { runs };
  }

  @Get('status')
  status() {
    return this.scraper.status();
  }

  @Get('history')
  history(@Query(new ZodPipe(historyQuery)) q: z.infer<typeof historyQuery>) {
    return this.scraper.history(q);
  }

  @Get('history/:id')
  runDetail(@Param('id') id: string) {
    return this.scraper.runById(id);
  }

  @Get('config')
  config() {
    return this.scraper.config();
  }

  @Post('config')
  @AdminOnly()
  async saveConfig(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const config = await this.scraper.updateConfig(body);
    await this.audit.log({ workspaceId: ctx.workspaceId, actorId: ctx.userId, action: 'scraper.config', entityType: 'ScraperConfig', entityId: 'scraper:config', next: body as object });
    return config;
  }

  @Put('config')
  @AdminOnly()
  replaceConfig(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.saveConfig(ctx, body);
  }

  @Get('jobs')
  listJobs(@Query(jobsPipe()) q: JobsQuery) {
    return this.list(q, q.only_new ? (q.since ?? new Date(Date.now() - NEW_WINDOW_HOURS * 3600_000)) : undefined);
  }

  /** Yeni ilanlar: since (varsayılan son 24 saat) sonrasında ilk kez görülenler. */
  @Get('jobs/new')
  newJobs(@Query(jobsPipe()) q: JobsQuery) {
    return this.list(q, q.since ?? new Date(Date.now() - NEW_WINDOW_HOURS * 3600_000));
  }

  @Get('jobs/:id')
  async job(@Param('id') id: string) {
    const row = await this.jobs.findById(id);
    if (!row) throw new AppError(404, 'NOT_FOUND', 'İlan bulunamadı');
    return toPublicJob(row);
  }

  private async list(q: JobsQuery, newSince: Date | undefined) {
    const page = await this.jobs.list({ source: q.source, city: q.city, company: q.company, title: q.title, status: q.status, from: q.from, to: q.to, newSince, includeDuplicates: q.include_duplicates, cursor: q.cursor, limit: q.limit });
    return { items: page.items.map(toPublicJob), total: page.total, next_cursor: page.nextCursor };
  }
}

@Module({ controllers: [ScrapersController] })
export class ScrapersModule {}
