import { Body, Controller, Get, Injectable, Module, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../../common/audit.service';
import { Ctx, RequestContext } from '../../common/auth';
import { OutboxService } from '../../common/outbox.service';
import { PrismaService } from '../../common/prisma.service';
import { ZodPipe } from '../../common/zod.pipe';
import { notificationCutoff } from '../../engine/notify.service';
import { SendingService } from '../../engine/sending.service';

const pauseSchema = z.object({ reason: z.string().max(300).optional() });

@Injectable()
export class WorkspaceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly sending: SendingService,
  ) {}

  /** Acil durdur: yeni otomatik gönderimleri durdurur; worker sağlayıcı çağrısından önce tekrar okur. */
  async pause(ctx: RequestContext, reason?: string) {
    return this.prisma.$transaction(async (tx) => {
      const ws = await tx.workspace.update({
        where: { id: ctx.workspaceId },
        data: { automationPaused: true, pausedAt: new Date(), pausedReason: reason ?? 'Kullanıcı acil durdur' },
      });
      const cancelledCount = await this.sending.cancelQueued({ workspaceId: ctx.workspaceId, sendMode: { in: ['auto', 'campaign', 'autopilot'] } }, 'EMERGENCY_STOP', tx);
      await this.audit.log({ workspaceId: ctx.workspaceId, actorId: ctx.userId, action: 'automation.pause', entityType: 'Workspace', entityId: ctx.workspaceId, reason }, tx);
      await this.outbox.emit(
        { workspaceId: ctx.workspaceId, eventType: 'notify', aggregateId: ctx.workspaceId, dedupKey: `pause:${ctx.workspaceId}:${Date.now()}`, payload: { type: 'automation_paused', title: 'Otomasyon durduruldu', body: `${cancelledCount} bekleyen otomatik gönderim iptal edildi.` } },
        tx,
      );
      return { workspace: ws, cancelledAttempts: cancelledCount };
    });
  }

  async resume(ctx: RequestContext) {
    const ws = await this.prisma.workspace.update({
      where: { id: ctx.workspaceId },
      data: { automationPaused: false, pausedAt: null, pausedReason: null },
    });
    await this.audit.log({ workspaceId: ctx.workspaceId, actorId: ctx.userId, action: 'automation.resume', entityType: 'Workspace', entityId: ctx.workspaceId });
    return { workspace: ws };
  }

  audit_(ctx: RequestContext, limit: number) {
    return this.prisma.auditEvent.findMany({ where: { workspaceId: ctx.workspaceId }, orderBy: { createdAt: 'desc' }, take: limit });
  }

  async dashboard(ctx: RequestContext) {
    const ws = ctx.workspaceId;
    const since = new Date(Date.now() - 7 * 86400_000);
    const [ws_, newOpps, strongCompanies, pendingDrafts, attemptsByState, sources, aiWaiting, recentNotifications, unknownSends] = await Promise.all([
      this.prisma.workspace.findUniqueOrThrow({ where: { id: ws } }),
      this.prisma.opportunity.findMany({
        where: { workspaceId: ws, category: { in: ['target_open', 'adjacent_open'] }, status: 'new' },
        include: { company: { select: { id: true, name: true } }, job: { select: { id: true, title: true, locationText: true, firstSeenAt: true } } },
        orderBy: [{ f: 'desc' }, { computedAt: 'desc' }],
        take: 10,
      }),
      this.prisma.company.findMany({
        where: { workspaceId: ws, excluded: false, qScore: { not: null } },
        orderBy: [{ qScore: 'desc' }],
        take: 8,
        select: { id: true, name: true, qScore: true, qCoverage: true, sectors: true },
      }),
      this.prisma.applicationDraft.count({ where: { workspaceId: ws, status: { in: ['draft', 'needs_review'] } } }),
      this.prisma.applicationAttempt.groupBy({ by: ['state'], where: { workspaceId: ws, createdAt: { gte: since } }, _count: true }),
      this.prisma.sourceConnector.findMany({
        where: { workspaceId: ws },
        select: { id: true, name: true, kind: true, health: true, healthReason: true, lastSuccessAt: true, lastRunAt: true, enabled: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.aiTask.count({ where: { workspaceId: ws, status: 'awaiting_user' } }),
      this.prisma.notification.findMany({ where: { workspaceId: ws, channel: 'in_app', createdAt: { gte: notificationCutoff() } }, orderBy: { createdAt: 'desc' }, take: 10 }),
      this.prisma.applicationAttempt.count({ where: { workspaceId: ws, state: 'submission_unknown' } }),
    ]);
    const heartbeat = await this.prisma.keyValue.findUnique({ where: { key: 'worker:heartbeat' } });
    return {
      workspace: ws_,
      newOpportunities: newOpps,
      strongCompanies,
      pendingDrafts,
      attemptsLast7Days: Object.fromEntries(attemptsByState.map((a) => [a.state, a._count])),
      unknownSends,
      sources,
      aiTasksWaiting: aiWaiting,
      notifications: recentNotifications,
      worker: heartbeat?.value ?? null,
      serverTime: new Date().toISOString(),
    };
  }
}

@Controller('v1')
export class WorkspaceController {
  constructor(private readonly svc: WorkspaceService) {}

  @Get('dashboard')
  dashboard(@Ctx() ctx: RequestContext) {
    return this.svc.dashboard(ctx);
  }

  @Post('automation/pause')
  pause(@Ctx() ctx: RequestContext, @Body(new ZodPipe(pauseSchema)) body: z.infer<typeof pauseSchema>) {
    return this.svc.pause(ctx, body.reason);
  }

  @Post('automation/resume')
  resume(@Ctx() ctx: RequestContext) {
    return this.svc.resume(ctx);
  }

  @Get('audit')
  audit(@Ctx() ctx: RequestContext, @Query('limit') limit?: string) {
    return this.svc.audit_(ctx, Math.min(parseInt(limit ?? '100', 10) || 100, 500));
  }
}

@Module({ controllers: [WorkspaceController], providers: [WorkspaceService], exports: [WorkspaceService] })
export class WorkspaceModule {}
