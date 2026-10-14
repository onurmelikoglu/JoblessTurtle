import { Body, Controller, Delete, Get, Injectable, Module, Param, Patch, Post } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AuditService } from '../../common/audit.service';
import { Ctx, RequestContext } from '../../common/auth';
import { AppError } from '../../common/errors';
import { OutboxService } from '../../common/outbox.service';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { ZodPipe } from '../../common/zod.pipe';
import { assertSafeUrl } from '../../domain/ssrf';
import { connectorCatalog, connectorFor } from '../../engine/connectors/registry';

const sourceSchema = z.object({
  kind: z.enum(['greenhouse', 'lever', 'career_page', 'demo', 'manual', 'linkedin', 'indeed', 'glassdoor', 'kariyernet']),
  name: z.string().min(1).max(160),
  companyId: z.string().optional().nullable(),
  config: z.record(z.any()).default({}),
  intervalMinutes: z.number().int().min(1).max(10080).optional(),
  permissionEvidence: z.string().max(1000).optional().nullable(),
  isOfficial: z.boolean().optional(),
  enabled: z.boolean().default(true),
});

@Injectable()
export class SourcesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
  ) {}

  catalog() {
    return connectorCatalog();
  }

  async list(ctx: RequestContext) {
    const sources = await this.prisma.sourceConnector.findMany({
      where: { workspaceId: ctx.workspaceId },
      include: { company: { select: { id: true, name: true } }, runs: { orderBy: { startedAt: 'desc' }, take: 5 }, _count: { select: { listings: true } } },
      orderBy: [{ health: 'asc' }, { name: 'asc' }],
    });
    return sources.map((s) => {
      const c = connectorFor(s.kind);
      return { ...s, connector: { label: c.label, accessMode: c.accessMode, applyChannel: c.applyChannel, minIntervalMinutes: c.minIntervalMinutes } };
    });
  }

  private validateConfig(kind: string, config: Record<string, any>) {
    if (kind === 'greenhouse' && !/^[a-z0-9_-]+$/i.test(config.boardToken ?? '')) throw new AppError(400, 'CONFIG_INVALID', 'Greenhouse için boardToken gerekli (ör. "firmaadi")');
    if (kind === 'lever' && !/^[a-z0-9_-]+$/i.test(config.site ?? '')) throw new AppError(400, 'CONFIG_INVALID', 'Lever için site adı gerekli');
    if (kind === 'career_page') {
      try {
        assertSafeUrl(config.url);
      } catch (e) {
        throw new AppError(400, 'CONFIG_INVALID', `Kariyer sayfası adresi geçersiz: ${(e as Error).message}`);
      }
    }
  }

  async create(ctx: RequestContext, input: z.infer<typeof sourceSchema>) {
    if (input.companyId) await this.scope.company(ctx, input.companyId);
    this.validateConfig(input.kind, input.config);
    const c = connectorFor(input.kind);
    // Kaynağın izin verdiği minimum aralığın altına inilemez; 1 dakika yalnızca API kaynaklarında.
    const interval = Math.max(input.intervalMinutes ?? c.defaultIntervalMinutes, c.minIntervalMinutes);
    const s = await this.prisma.sourceConnector.create({
      data: {
        workspaceId: ctx.workspaceId,
        companyId: input.companyId ?? null,
        kind: input.kind,
        name: input.name,
        config: input.config as Prisma.InputJsonValue,
        accessMode: c.accessMode,
        capabilities: c.capabilities,
        minIntervalMinutes: c.minIntervalMinutes,
        intervalMinutes: interval,
        isOfficial: input.isOfficial ?? c.isOfficial,
        permissionEvidence: input.permissionEvidence ?? null,
        permissionCheckedAt: input.permissionEvidence ? new Date() : null,
        enabled: input.enabled,
        health: c.accessMode === 'manual' ? 'healthy' : 'unknown',
        nextRunAt: c.accessMode === 'manual' ? null : new Date(),
      },
    });
    await this.audit.log({ workspaceId: ctx.workspaceId, actorId: ctx.userId, action: 'source.create', entityType: 'SourceConnector', entityId: s.id });
    return s;
  }

  async update(ctx: RequestContext, id: string, input: Partial<z.infer<typeof sourceSchema>>) {
    const prev = await this.scope.source(ctx, id);
    const c = connectorFor(prev.kind);
    if (input.config) this.validateConfig(prev.kind, input.config);
    const data: Prisma.SourceConnectorUpdateInput = {
      name: input.name,
      config: input.config as Prisma.InputJsonValue | undefined,
      permissionEvidence: input.permissionEvidence,
      enabled: input.enabled,
      isOfficial: input.isOfficial,
    };
    if (input.intervalMinutes) data.intervalMinutes = Math.max(input.intervalMinutes, c.minIntervalMinutes);
    if (input.permissionEvidence) data.permissionCheckedAt = new Date();
    // Kullanıcı engellenmiş kaynağı yeniden etkinleştirirse sağlık sıfırlanır ve hemen denenir.
    if (input.enabled === true && prev.health === 'blocked') Object.assign(data, { health: 'unknown', healthReason: null, nextRunAt: new Date(), consecutiveFailures: 0 });
    const s = await this.prisma.sourceConnector.update({ where: { id }, data });
    await this.audit.log({ workspaceId: ctx.workspaceId, actorId: ctx.userId, action: 'source.update', entityType: 'SourceConnector', entityId: id, previous: { enabled: prev.enabled, interval: prev.intervalMinutes }, next: { enabled: s.enabled, interval: s.intervalMinutes } });
    return s;
  }

  async remove(ctx: RequestContext, id: string) {
    await this.scope.source(ctx, id);
    await this.prisma.sourceConnector.delete({ where: { id } });
    return { ok: true };
  }

  async runNow(ctx: RequestContext, id: string) {
    const s = await this.scope.source(ctx, id);
    if (connectorFor(s.kind).accessMode === 'manual') throw new AppError(422, 'CHANNEL_MANUAL_ONLY', 'Bu kaynak yalnızca manuel kayıtla çalışır');
    await this.outbox.emit({ workspaceId: ctx.workspaceId, eventType: 'collect.source', aggregateId: id, dedupKey: `collect:${id}:manual:${Date.now()}`, payload: { sourceId: id, trigger: 'manual' } });
    return { queued: true };
  }

  async runs(ctx: RequestContext, id: string) {
    await this.scope.source(ctx, id);
    return this.prisma.crawlRun.findMany({ where: { sourceId: id }, orderBy: { startedAt: 'desc' }, take: 50 });
  }
}

@Controller('v1')
export class SourcesController {
  constructor(private readonly svc: SourcesService) {}

  @Get('source-catalog')
  catalog() {
    return this.svc.catalog();
  }

  @Get('sources')
  list(@Ctx() ctx: RequestContext) {
    return this.svc.list(ctx);
  }

  @Post('sources')
  create(@Ctx() ctx: RequestContext, @Body(new ZodPipe(sourceSchema)) body: z.infer<typeof sourceSchema>) {
    return this.svc.create(ctx, body);
  }

  @Patch('sources/:id')
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new ZodPipe(sourceSchema.partial())) body: Partial<z.infer<typeof sourceSchema>>) {
    return this.svc.update(ctx, id, body);
  }

  @Delete('sources/:id')
  remove(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.svc.remove(ctx, id);
  }

  @Post('sources/:id/run')
  run(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.svc.runNow(ctx, id);
  }

  @Get('sources/:id/runs')
  runs(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.svc.runs(ctx, id);
  }
}

@Module({ controllers: [SourcesController], providers: [SourcesService] })
export class SourcesModule {}
