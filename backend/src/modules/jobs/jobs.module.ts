import { Body, Controller, Get, Injectable, Module, Param, Patch, Post, Query } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AuditService } from '../../common/audit.service';
import { Ctx, RequestContext } from '../../common/auth';
import { sha256 } from '../../common/crypto';
import { AppError, notFound } from '../../common/errors';
import { OutboxService } from '../../common/outbox.service';
import { cursorArgs, paginate, pageQuery } from '../../common/pagination';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { ZodPipe } from '../../common/zod.pipe';
import { CATEGORY_LABELS } from '../../domain/scoring';
import { normalizeCompanyName, normalizeDomain } from '../../domain/text';
import { connectorFor } from '../../engine/connectors/registry';
import { DraftingService, intentForCategory } from '../../engine/drafting.service';
import { IngestService } from '../../engine/ingest.service';

const jobsQuery = pageQuery.extend({
  status: z.enum(['open', 'closed', 'unknown', 'stale']).optional(),
  companyId: z.string().optional(),
  search: z.string().optional(),
  mergeReview: z.enum(['true']).optional(),
});
const manualJobSchema = z.object({
  platform: z.enum(['manual', 'linkedin', 'indeed', 'glassdoor', 'kariyernet']).default('manual'),
  companyId: z.string().optional(),
  companyName: z.string().max(200).optional(),
  companyWebsite: z.string().max(300).optional(),
  title: z.string().min(1).max(200),
  url: z.string().max(1000).optional().nullable(),
  locationText: z.string().max(200).optional().nullable(),
  description: z.string().max(8000).optional().nullable(),
  applyEmail: z.string().email().optional().nullable(),
  externalId: z.string().max(200).optional(),
  postedAt: z.string().optional().nullable(),
});
const jobPatch = z.object({
  applyEmail: z.string().email().nullable().optional(),
  channel: z.enum(['email', 'platform', 'ats_form', 'unknown']).optional(),
  mergeReview: z.boolean().optional(),
  userStatus: z.enum(['closed', 'open']).optional(),
  workMode: z.enum(['onsite', 'hybrid', 'remote', 'unknown']).optional(),
  locationText: z.string().max(200).optional(),
});
const oppQuery = pageQuery.extend({
  searchProfileId: z.string().optional(),
  category: z.string().optional(),
  status: z.string().optional(),
  minF: z.coerce.number().optional(),
  minQ: z.coerce.number().optional(),
  location: z.string().optional(),
  companyId: z.string().optional(),
});
const oppPatch = z.object({ status: z.enum(['new', 'reviewed', 'dismissed', 'drafted', 'applied']) });
const draftFromOpp = z.object({
  candidateId: z.string().optional(),
  intentType: z.enum(['job_application', 'intent_after_closed', 'general_intent', 'project_collab']).optional(),
  mailAccountId: z.string().optional(),
  contactId: z.string().optional(),
  documentIds: z.array(z.string()).optional(),
  useAi: z.boolean().default(true),
});

@Injectable()
export class JobsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly ingest: IngestService,
    private readonly drafting: DraftingService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
  ) {}

  async list(ctx: RequestContext, q: z.infer<typeof jobsQuery>) {
    const where: Prisma.JobWhereInput = { workspaceId: ctx.workspaceId };
    if (q.status) where.status = q.status;
    if (q.companyId) where.companyId = q.companyId;
    if (q.mergeReview) where.mergeReview = true;
    if (q.search) where.OR = [{ title: { contains: q.search, mode: 'insensitive' } }, { company: { name: { contains: q.search, mode: 'insensitive' } } }];
    const rows = await this.prisma.job.findMany({
      where,
      orderBy: [{ firstSeenAt: 'desc' }, { id: 'asc' }],
      ...cursorArgs(q),
      include: {
        company: { select: { id: true, name: true, qScore: true } },
        listings: { select: { id: true, status: true, isOfficial: true, canonicalUrl: true, lastVerifiedAt: true, source: { select: { id: true, name: true, kind: true, health: true } } } },
        opportunities: { select: { id: true, category: true, f: true, titleMatch: true, searchProfileId: true, status: true } },
      },
    });
    return paginate(rows, q.limit);
  }

  async get(ctx: RequestContext, id: string) {
    await this.scope.job(ctx, id);
    return this.prisma.job.findUniqueOrThrow({
      where: { id },
      include: {
        company: true,
        office: true,
        listings: { include: { source: { select: { id: true, name: true, kind: true, health: true, healthReason: true } }, snapshots: { orderBy: { createdAt: 'desc' }, take: 20 } } },
        opportunities: { include: { searchProfile: { select: { id: true, name: true } } } },
      },
    });
  }

  async createManual(ctx: RequestContext, input: z.infer<typeof manualJobSchema>) {
    let companyId = input.companyId;
    if (companyId) await this.scope.company(ctx, companyId);
    else {
      if (!input.companyName) throw new AppError(400, 'COMPANY_REQUIRED', 'Firma seçin veya firma adı girin');
      const domain = normalizeDomain(input.companyWebsite);
      const normalizedName = normalizeCompanyName(input.companyName);
      const existing = await this.prisma.company.findFirst({ where: { workspaceId: ctx.workspaceId, OR: [...(domain ? [{ canonicalDomain: domain }] : []), { normalizedName }] } });
      companyId =
        existing?.id ??
        (await this.prisma.company.create({ data: { workspaceId: ctx.workspaceId, name: input.companyName, normalizedName, canonicalDomain: domain, website: domain ? `https://${domain}` : null, origin: 'manual' } })).id;
    }
    let source = await this.prisma.sourceConnector.findFirst({ where: { workspaceId: ctx.workspaceId, kind: input.platform, companyId: null } });
    if (!source) {
      const c = connectorFor(input.platform);
      source = await this.prisma.sourceConnector.create({
        data: { workspaceId: ctx.workspaceId, kind: input.platform, name: c.label, accessMode: 'manual', capabilities: c.capabilities, isOfficial: false, health: 'healthy', minIntervalMinutes: 0, intervalMinutes: 0 },
      });
    }
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: companyId } });
    const listing = await this.ingest.recordManual(source, {
      externalId: input.externalId ?? sha256(`${input.url ?? ''}|${companyId}|${input.title}`).slice(0, 24),
      title: input.title,
      url: input.url ?? null,
      locationText: input.locationText ?? null,
      description: input.description ?? null,
      applyEmail: input.applyEmail ?? null,
      postedAt: input.postedAt ? new Date(input.postedAt) : null,
      companyName: company.name,
      companyDomain: company.canonicalDomain,
    });
    // Platform kaynaklı kayıtta başvuru kanalı platformdur; e-posta verilmişse e-posta kanalı açılır.
    await this.prisma.job.update({ where: { id: listing.jobId }, data: { companyId, channel: input.applyEmail ? 'email' : input.platform === 'manual' ? 'unknown' : 'platform', applyUrl: input.url ?? undefined } });
    await this.audit.log({ workspaceId: ctx.workspaceId, actorId: ctx.userId, action: 'job.manual_create', entityType: 'Job', entityId: listing.jobId });
    return this.get(ctx, listing.jobId);
  }

  async update(ctx: RequestContext, id: string, input: z.infer<typeof jobPatch>) {
    const job = await this.scope.job(ctx, id);
    const data: Prisma.JobUpdateInput = {
      applyEmail: input.applyEmail,
      channel: input.channel ?? (input.applyEmail ? 'email' : undefined),
      mergeReview: input.mergeReview,
      workMode: input.workMode,
      locationText: input.locationText,
    };
    if (input.userStatus) {
      data.status = input.userStatus;
      data.statusReason = 'user_marked';
      if (input.userStatus === 'closed') data.closedAt = new Date();
    }
    const u = await this.prisma.job.update({ where: { id }, data });
    if (input.userStatus === 'closed' && job.status !== 'closed') {
      await this.outbox.emit({ workspaceId: ctx.workspaceId, eventType: 'job.closed', aggregateId: id, dedupKey: `job-closed:${id}:user:${Date.now()}`, payload: { jobId: id } });
    }
    await this.outbox.emit({ workspaceId: ctx.workspaceId, eventType: 'evaluate.company', aggregateId: job.companyId, dedupKey: `eval-company:${job.companyId}:job:${Date.now()}`, payload: { companyId: job.companyId } });
    await this.audit.log({ workspaceId: ctx.workspaceId, actorId: ctx.userId, action: 'job.update', entityType: 'Job', entityId: id, previous: { status: job.status, applyEmail: job.applyEmail }, next: input });
    return u;
  }

  async opportunities(ctx: RequestContext, q: z.infer<typeof oppQuery>) {
    const where: Prisma.OpportunityWhereInput = { workspaceId: ctx.workspaceId };
    if (q.searchProfileId) where.searchProfileId = q.searchProfileId;
    if (q.category) where.category = { in: q.category.split(',') };
    if (q.status) where.status = { in: q.status.split(',') };
    if (q.minF !== undefined) where.f = { gte: q.minF };
    if (q.minQ !== undefined) where.q = { gte: q.minQ };
    if (q.location) where.locationState = { in: q.location.split(',') };
    if (q.companyId) where.companyId = q.companyId;
    const rows = await this.prisma.opportunity.findMany({
      where,
      orderBy: [{ f: { sort: 'desc', nulls: 'last' } }, { q: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }],
      ...cursorArgs(q),
      include: {
        company: { select: { id: true, name: true, qScore: true, qCoverage: true, sectors: true, offices: { select: { district: true } } } },
        job: { select: { id: true, title: true, status: true, locationText: true, firstSeenAt: true, lastVerifiedAt: true, channel: true, applyUrl: true } },
        searchProfile: { select: { id: true, name: true } },
      },
    });
    const page = paginate(rows, q.limit);
    return { ...page, categoryLabels: CATEGORY_LABELS };
  }

  async updateOpportunity(ctx: RequestContext, id: string, input: z.infer<typeof oppPatch>) {
    const o = await this.prisma.opportunity.findFirst({ where: { id, workspaceId: ctx.workspaceId } });
    if (!o) throw notFound('Fırsat');
    return this.prisma.opportunity.update({ where: { id }, data: { status: input.status } });
  }

  async draftFromOpportunity(ctx: RequestContext, id: string, input: z.infer<typeof draftFromOpp>) {
    const o = await this.prisma.opportunity.findFirst({ where: { id, workspaceId: ctx.workspaceId }, include: { searchProfile: true } });
    if (!o) throw notFound('Fırsat');
    const candidateId = input.candidateId ?? o.searchProfile.candidateId;
    await this.scope.candidate(ctx, candidateId);
    const intent = input.intentType ?? intentForCategory(o.category);
    const draft = await this.drafting.create({
      workspaceId: ctx.workspaceId,
      candidateId,
      companyId: o.companyId,
      jobId: intent === 'job_application' || intent === 'intent_after_closed' ? o.jobId : null,
      opportunityId: o.id,
      intentType: intent,
      mailAccountId: input.mailAccountId,
      contactId: input.contactId,
      documentIds: input.documentIds,
      origin: 'manual',
      createdById: ctx.userId,
      useAi: input.useAi,
    });
    await this.prisma.opportunity.update({ where: { id }, data: { status: 'drafted' } });
    return draft;
  }

  async reevaluate(ctx: RequestContext) {
    const profiles = await this.prisma.searchProfile.findMany({ where: { workspaceId: ctx.workspaceId, active: true } });
    for (const p of profiles) {
      await this.outbox.emit({ workspaceId: ctx.workspaceId, eventType: 'evaluate.profile', aggregateId: p.id, dedupKey: `eval-profile:${p.id}:manual:${Date.now()}`, payload: {} });
    }
    return { queued: profiles.length };
  }
}

@Controller('v1')
export class JobsController {
  constructor(private readonly svc: JobsService) {}

  @Get('jobs')
  list(@Ctx() ctx: RequestContext, @Query(new ZodPipe(jobsQuery)) q: z.infer<typeof jobsQuery>) {
    return this.svc.list(ctx, q);
  }

  @Get('jobs/:id')
  get(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.svc.get(ctx, id);
  }

  @Post('jobs/manual')
  createManual(@Ctx() ctx: RequestContext, @Body(new ZodPipe(manualJobSchema)) body: z.infer<typeof manualJobSchema>) {
    return this.svc.createManual(ctx, body);
  }

  @Patch('jobs/:id')
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new ZodPipe(jobPatch)) body: z.infer<typeof jobPatch>) {
    return this.svc.update(ctx, id, body);
  }

  @Get('opportunities')
  opportunities(@Ctx() ctx: RequestContext, @Query(new ZodPipe(oppQuery)) q: z.infer<typeof oppQuery>) {
    return this.svc.opportunities(ctx, q);
  }

  @Patch('opportunities/:id')
  updateOpportunity(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new ZodPipe(oppPatch)) body: z.infer<typeof oppPatch>) {
    return this.svc.updateOpportunity(ctx, id, body);
  }

  @Post('opportunities/:id/draft')
  draft(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new ZodPipe(draftFromOpp)) body: z.infer<typeof draftFromOpp>) {
    return this.svc.draftFromOpportunity(ctx, id, body);
  }

  @Post('evaluate')
  reevaluate(@Ctx() ctx: RequestContext) {
    return this.svc.reevaluate(ctx);
  }
}

@Module({ controllers: [JobsController], providers: [JobsService] })
export class JobsModule {}
