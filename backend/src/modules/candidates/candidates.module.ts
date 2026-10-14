import { Body, Controller, Delete, Get, Injectable, Module, Param, Patch, Post } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AuditService } from '../../common/audit.service';
import { Ctx, RequestContext } from '../../common/auth';
import { conflict } from '../../common/errors';
import { OutboxService } from '../../common/outbox.service';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { ZodPipe } from '../../common/zod.pipe';
import { SendingService } from '../../engine/sending.service';

const fact = z.object({ key: z.string().min(1), label: z.string().min(1), value: z.string() });
const portfolioItem = z.object({
  title: z.string().min(1),
  client: z.string().optional(),
  year: z.number().int().optional(),
  url: z.string().url().optional(),
  tags: z.array(z.string()).default([]),
});

const candidateSchema = z.object({
  displayName: z.string().min(1).max(120),
  email: z.string().email().optional().nullable(),
  phone: z.string().max(40).optional().nullable(),
  headline: z.string().max(600).optional().nullable(),
  city: z.string().max(80).optional().nullable(),
  verifiedFacts: z.array(fact).default([]),
  languages: z.array(z.object({ language: z.string(), level: z.string() })).default([]),
  experienceYears: z.number().int().min(0).max(60).optional().nullable(),
  teamManagement: z.boolean().optional().nullable(),
  workModes: z.array(z.enum(['onsite', 'hybrid', 'remote'])).default([]),
  employmentTypes: z.array(z.string()).default([]),
  workPermit: z.string().optional().nullable(),
  portfolioUrl: z.string().url().optional().nullable(),
  portfolioItems: z.array(portfolioItem).default([]),
  signature: z.string().max(1000).optional().nullable(),
  consentVersion: z.string().optional().nullable(),
});

const condition = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  required: z.boolean().default(false),
  met: z.boolean().nullable().default(null),
});

const searchProfileSchema = z.object({
  candidateId: z.string(),
  name: z.string().min(1).max(120),
  exactTitles: z.array(z.string().min(1)).default([]),
  adjacentTitles: z.array(z.string().min(1)).default([]),
  excludedTitles: z.array(z.string().min(1)).default([]),
  sectors: z.array(z.string()).default([]),
  excludedSectors: z.array(z.string()).default([]),
  keywords: z.array(z.string()).default([]),
  city: z.string().optional().nullable(),
  districtsPrimary: z.array(z.string()).default([]),
  districtsConditional: z.array(z.string()).default([]),
  allowRemote: z.boolean().default(false),
  allowHybrid: z.boolean().default(true),
  abroadRemote: z.boolean().default(false),
  abroadRelocation: z.boolean().default(false),
  abroadRegions: z.array(z.string().trim().min(1).max(60)).max(12).default([]),
  unknownLocationAction: z.enum(['review', 'exclude', 'include']).default('review'),
  autoIncludeAdjacent: z.boolean().default(false),
  requiredConditions: z.array(condition).default([]),
  qWeights: z
    .object({ customer: z.number(), campaign: z.number(), reputation: z.number(), service_fit: z.number(), production: z.number() })
    .partial()
    .optional()
    .nullable(),
  active: z.boolean().default(true),
});
const DISCOVERY_FIELDS = ['exactTitles', 'adjacentTitles', 'excludedTitles', 'keywords', 'sectors', 'city', 'districtsPrimary', 'districtsConditional', 'active'] as const;
/** İlan aramasını etkileyen alanlar: keşif alanlarına ek olarak uzaktan ve yurt dışı kapsamı. */
const JOB_SEARCH_FIELDS = [...DISCOVERY_FIELDS, 'allowRemote', 'abroadRemote', 'abroadRelocation', 'abroadRegions'] as const;

function changed(fields: readonly string[], prev: Record<string, unknown>, next: Record<string, unknown>): boolean {
  return fields.some((f) => JSON.stringify(prev[f] ?? null) !== JSON.stringify(next[f] ?? null));
}

function discoveryInputsChanged(prev: Record<string, unknown>, next: Record<string, unknown>): boolean {
  return changed(DISCOVERY_FIELDS, prev, next);
}

const searchProfilePatch = searchProfileSchema.partial().omit({ candidateId: true }).extend({ revision: z.number().int() });

@Injectable()
export class CandidatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly sending: SendingService,
  ) {}

  list(ctx: RequestContext) {
    return this.prisma.candidateProfile.findMany({
      where: { workspaceId: ctx.workspaceId },
      include: {
        searchProfiles: true,
        mailAccounts: { select: { id: true, provider: true, accountEmail: true, health: true, scopeSet: true, dailyLimit: true } },
        documents: { where: { archived: false }, orderBy: { createdAt: 'desc' } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async get(ctx: RequestContext, id: string) {
    await this.scope.candidate(ctx, id);
    return (await this.list(ctx)).find((c) => c.id === id);
  }

  async create(ctx: RequestContext, input: z.infer<typeof candidateSchema>) {
    const c = await this.prisma.candidateProfile.create({
      data: { ...input, workspaceId: ctx.workspaceId, ownerId: ctx.userId } as Prisma.CandidateProfileUncheckedCreateInput,
    });
    await this.audit.log({ workspaceId: ctx.workspaceId, actorId: ctx.userId, action: 'candidate.create', entityType: 'CandidateProfile', entityId: c.id });
    return c;
  }

  async update(ctx: RequestContext, id: string, input: Partial<z.infer<typeof candidateSchema>>) {
    const prev = await this.scope.candidate(ctx, id);
    const c = await this.prisma.candidateProfile.update({ where: { id }, data: input as Prisma.CandidateProfileUpdateInput });
    await this.audit.log({
      workspaceId: ctx.workspaceId,
      actorId: ctx.userId,
      action: 'candidate.update',
      entityType: 'CandidateProfile',
      entityId: id,
      previous: { verifiedFacts: prev.verifiedFacts },
      next: { verifiedFacts: c.verifiedFacts },
    });
    return c;
  }

  async remove(ctx: RequestContext, id: string) {
    await this.scope.candidate(ctx, id);
    // Aday silinince bağlı hesap tokenları ve belgeler de silinir; bekleyen gönderimler iptal edilir.
    await this.prisma.$transaction(async (tx) => {
      await this.sending.cancelQueued({ candidateId: id }, 'CANDIDATE_DELETED', tx);
      const attemptIds = (await tx.applicationAttempt.findMany({ where: { candidateId: id }, select: { id: true } })).map((a) => a.id);
      await tx.followUp.updateMany({ where: { attemptId: { in: attemptIds }, state: 'pending' }, data: { state: 'cancelled', cancellationReason: 'CANDIDATE_DELETED' } });
      await tx.applicationDraft.updateMany({ where: { candidateId: id, status: { in: ['draft', 'needs_review', 'queued'] } }, data: { status: 'cancelled' } });
      await tx.candidateProfile.delete({ where: { id } });
      await this.outbox.emit({ workspaceId: ctx.workspaceId, eventType: 'storage.purge_candidate', aggregateId: id, dedupKey: `purge:${id}` }, tx);
    });
    await this.audit.log({ workspaceId: ctx.workspaceId, actorId: ctx.userId, action: 'candidate.delete', entityType: 'CandidateProfile', entityId: id });
    return { ok: true };
  }

  // ─── Arama profilleri ───
  listProfiles(ctx: RequestContext) {
    return this.prisma.searchProfile.findMany({ where: { workspaceId: ctx.workspaceId }, orderBy: { createdAt: 'asc' } });
  }

  async createProfile(ctx: RequestContext, input: z.infer<typeof searchProfileSchema>) {
    await this.scope.candidate(ctx, input.candidateId);
    const p = await this.prisma.$transaction(async (tx) => {
      const p = await tx.searchProfile.create({
        data: { ...input, workspaceId: ctx.workspaceId, qWeights: input.qWeights ?? undefined } as Prisma.SearchProfileUncheckedCreateInput,
      });
      await this.outbox.emit({ workspaceId: ctx.workspaceId, eventType: 'evaluate.profile', aggregateId: p.id, dedupKey: `eval-profile:${p.id}:1` }, tx);
      // Firmalar elle girilmez: profil kaydedilir kaydedilmez önce ortak katalogdaki uygun firmalar eklenir, ardından unvanlara göre ilk keşif başlar.
      if (p.active && p.exactTitles.length + p.adjacentTitles.length > 0) {
        await this.outbox.emit({ workspaceId: ctx.workspaceId, eventType: 'catalog.seed', aggregateId: p.id, dedupKey: `catalog-seed:${p.id}:1` }, tx);
        await this.outbox.emit({ workspaceId: ctx.workspaceId, eventType: 'jobs.plan', aggregateId: p.id, dedupKey: `jobs-plan:${p.id}:1`, payload: { searchProfileId: p.id, actorId: ctx.userId } }, tx);
        await this.outbox.emit(
          { workspaceId: ctx.workspaceId, eventType: 'discovery.ai', aggregateId: ctx.workspaceId, dedupKey: `discovery:profile:${p.id}:1`, payload: { searchProfileId: p.id, actorId: ctx.userId, allowManual: true } },
          tx,
        );
      }
      return p;
    });
    await this.audit.log({ workspaceId: ctx.workspaceId, actorId: ctx.userId, action: 'search_profile.create', entityType: 'SearchProfile', entityId: p.id });
    return p;
  }

  async updateProfile(ctx: RequestContext, id: string, input: z.infer<typeof searchProfilePatch>) {
    const prev = await this.scope.searchProfile(ctx, id);
    const { revision, ...data } = input;
    if (prev.revision !== revision)
      throw conflict('REVISION_CONFLICT', 'Profil başka bir ekranda değiştirilmiş; sayfayı yenileyin', { current: prev.revision });
    const p = await this.prisma.$transaction(async (tx) => {
      const res = await tx.searchProfile.updateMany({
        where: { id, revision },
        data: { ...(data as Prisma.SearchProfileUpdateManyMutationInput), qWeights: data.qWeights ?? undefined, revision: { increment: 1 } },
      });
      if (res.count !== 1) throw conflict('REVISION_CONFLICT', 'Profil başka bir ekranda değiştirilmiş');
      const p = await tx.searchProfile.findUniqueOrThrow({ where: { id } });
      await this.outbox.emit({ workspaceId: ctx.workspaceId, eventType: 'evaluate.profile', aggregateId: id, dedupKey: `eval-profile:${id}:${p.revision}` }, tx);
      // Unvan/bölge/sektör değiştiyse keşif yenilenir; arka planda olduğundan manuel köprü görevi açılmaz.
      if (p.active && p.exactTitles.length + p.adjacentTitles.length > 0 && changed(JOB_SEARCH_FIELDS, prev, p))
        await this.outbox.emit({ workspaceId: ctx.workspaceId, eventType: 'jobs.plan', aggregateId: id, dedupKey: `jobs-plan:${id}:${p.revision}`, payload: { searchProfileId: id, actorId: ctx.userId } }, tx);
      if (p.active && p.exactTitles.length + p.adjacentTitles.length > 0 && discoveryInputsChanged(prev, p)) {
        await this.outbox.emit({ workspaceId: ctx.workspaceId, eventType: 'catalog.seed', aggregateId: id, dedupKey: `catalog-seed:${id}:${p.revision}` }, tx);
        await this.outbox.emit(
          { workspaceId: ctx.workspaceId, eventType: 'discovery.ai', aggregateId: ctx.workspaceId, dedupKey: `discovery:profile:${id}:${p.revision}`, payload: { searchProfileId: id, actorId: ctx.userId, allowManual: false } },
          tx,
        );
      }
      return p;
    });
    await this.audit.log({ workspaceId: ctx.workspaceId, actorId: ctx.userId, action: 'search_profile.update', entityType: 'SearchProfile', entityId: id, previous: prev, next: p });
    return p;
  }

  async removeProfile(ctx: RequestContext, id: string) {
    await this.scope.searchProfile(ctx, id);
    await this.prisma.searchProfile.delete({ where: { id } });
    return { ok: true };
  }
}

@Controller('v1')
export class CandidatesController {
  constructor(private readonly svc: CandidatesService) {}

  @Get('candidates')
  list(@Ctx() ctx: RequestContext) {
    return this.svc.list(ctx);
  }

  @Get('candidates/:id')
  get(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.svc.get(ctx, id);
  }

  @Post('candidates')
  create(@Ctx() ctx: RequestContext, @Body(new ZodPipe(candidateSchema)) body: z.infer<typeof candidateSchema>) {
    return this.svc.create(ctx, body);
  }

  @Patch('candidates/:id')
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new ZodPipe(candidateSchema.partial())) body: Partial<z.infer<typeof candidateSchema>>) {
    return this.svc.update(ctx, id, body);
  }

  @Delete('candidates/:id')
  remove(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.svc.remove(ctx, id);
  }

  @Get('search-profiles')
  profiles(@Ctx() ctx: RequestContext) {
    return this.svc.listProfiles(ctx);
  }

  @Post('search-profiles')
  createProfile(@Ctx() ctx: RequestContext, @Body(new ZodPipe(searchProfileSchema)) body: z.infer<typeof searchProfileSchema>) {
    return this.svc.createProfile(ctx, body);
  }

  @Patch('search-profiles/:id')
  updateProfile(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new ZodPipe(searchProfilePatch)) body: z.infer<typeof searchProfilePatch>) {
    return this.svc.updateProfile(ctx, id, body);
  }

  @Delete('search-profiles/:id')
  removeProfile(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.svc.removeProfile(ctx, id);
  }
}

@Module({ controllers: [CandidatesController], providers: [CandidatesService], exports: [CandidatesService] })
export class CandidatesModule {}
