import { Body, Controller, Get, Headers, Injectable, Module, Param, Post, Req } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHmac, timingSafeEqual } from 'crypto';
import Redis from 'ioredis';
import { z } from 'zod';
import { Public } from '../../common/auth';
import { env } from '../../common/env';
import { AppError } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { RepliesService } from '../../engine/replies.service';

const webhookSchema = z.object({
  workspaceId: z.string(),
  attemptId: z.string().optional(),
  providerThreadId: z.string().optional(),
  messageId: z.string().min(1),
  subject: z.string().max(300).optional(),
  snippet: z.string().max(4000).optional(),
  fromEmail: z.string().email().optional(),
  classification: z.enum(['human_reply', 'autoresponder', 'bounce', 'rejection', 'interview', 'do_not_contact', 'unknown']).optional(),
});

@Injectable()
export class SystemService {
  private redis: Redis | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly replies: RepliesService,
  ) {}

  async health() {
    const checks: Record<string, unknown> = {};
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      checks.database = 'ok';
    } catch {
      checks.database = 'error';
    }
    try {
      this.redis ??= new Redis(env().REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
      if (this.redis.status !== 'ready') await this.redis.connect().catch(() => undefined);
      checks.redis = (await this.redis.ping()) === 'PONG' ? 'ok' : 'error';
    } catch {
      checks.redis = 'error';
    }
    const hb = await this.prisma.keyValue.findUnique({ where: { key: 'worker:heartbeat' } }).catch(() => null);
    const at = (hb?.value as any)?.at ? new Date((hb?.value as any).at) : null;
    checks.worker = at && Date.now() - at.getTime() < 3 * 60_000 ? 'ok' : 'stale';
    checks.workerLastSeen = at?.toISOString() ?? null;
    const ok = checks.database === 'ok' && checks.redis === 'ok';
    return { status: ok ? 'ok' : 'degraded', version: process.env.APP_VERSION ?? '1.0.0', time: new Date().toISOString(), checks };
  }

  /**
   * Doğrulanmış mailbox/bildirim olayları: HMAC-SHA256 imzası + event ID ile replay koruması.
   * Sahte yanıt veya başvuru onayı işlem tetikleyemez.
   */
  async webhook(provider: string, rawBody: Buffer | undefined, signature: string | undefined, eventId: string | undefined, body: unknown) {
    if (!rawBody || !signature || !eventId) throw new AppError(401, 'SIGNATURE_REQUIRED', 'İmza ve olay kimliği gerekli');
    const expected = `sha256=${createHmac('sha256', env().WEBHOOK_SECRET).update(rawBody).digest('hex')}`;
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new AppError(401, 'SIGNATURE_INVALID', 'İmza doğrulanamadı');
    try {
      await this.prisma.webhookEvent.create({ data: { provider, eventId } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return { duplicate: true };
      throw e;
    }
    const parsed = webhookSchema.safeParse(body);
    if (!parsed.success) throw new AppError(400, 'VALIDATION_FAILED', 'Olay gövdesi geçersiz', parsed.error.flatten());
    const p = parsed.data;
    const attempt = await this.prisma.applicationAttempt.findFirst({
      where: { workspaceId: p.workspaceId, OR: [...(p.attemptId ? [{ id: p.attemptId }] : []), ...(p.providerThreadId ? [{ providerThreadId: p.providerThreadId }] : [])] },
    });
    if (!attempt) return { matched: false };
    const r = await this.replies.record({ workspaceId: p.workspaceId, attemptId: attempt.id, providerMessageId: `${provider}:${p.messageId}`, subject: p.subject, snippet: p.snippet, fromEmail: p.fromEmail, classification: p.classification ?? null, source: 'webhook' });
    return { matched: true, duplicate: r.duplicate };
  }
}

@Controller()
export class SystemController {
  constructor(private readonly svc: SystemService) {}

  @Public()
  @Get('health')
  health() {
    return this.svc.health();
  }

  @Public()
  @Get('v1/health')
  healthV1() {
    return this.svc.health();
  }

  @Public()
  @Post('v1/webhooks/:provider')
  webhook(
    @Param('provider') provider: string,
    @Req() req: { rawBody?: Buffer },
    @Headers('x-signature') signature: string | undefined,
    @Headers('x-event-id') eventId: string | undefined,
    @Body() body: unknown,
  ) {
    return this.svc.webhook(provider, req.rawBody, signature, eventId, body);
  }
}

@Module({ controllers: [SystemController], providers: [SystemService] })
export class SystemModule {}
