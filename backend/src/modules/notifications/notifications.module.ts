import { Controller, Get, Injectable, MessageEvent, Module, OnModuleDestroy, Param, Post, Query, Sse } from '@nestjs/common';
import Redis from 'ioredis';
import { interval, map, merge, Observable } from 'rxjs';
import { Ctx, RequestContext } from '../../common/auth';
import { randomCode } from '../../common/crypto';
import { env } from '../../common/env';
import { PrismaService } from '../../common/prisma.service';
import { notificationCutoff } from '../../engine/notify.service';

export const EVENTS_CHANNEL = (ws: string) => `events:${ws}`;

@Injectable()
export class NotificationsService implements OnModuleDestroy {
  private sub: Redis | null = null;
  private listeners = new Map<string, Set<(e: MessageEvent) => void>>();

  constructor(private readonly prisma: PrismaService) {}

  onModuleDestroy() {
    this.sub?.disconnect();
  }

  private ensureSub() {
    if (this.sub) return;
    this.sub = new Redis(env().REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: null });
    this.sub.on('error', () => undefined);
    this.sub.psubscribe('events:*');
    this.sub.on('pmessage', (_p, channel, message) => {
      const ws = channel.slice('events:'.length);
      for (const fn of this.listeners.get(ws) ?? []) {
        try {
          fn({ data: JSON.parse(message) });
        } catch {
          /* yoksay */
        }
      }
    });
  }

  /** Canlı durum akışı (SSE): worker olayları Redis üzerinden yayınlar; 25 sn'de bir kalp atışı. */
  stream(workspaceId: string): Observable<MessageEvent> {
    this.ensureSub();
    const events = new Observable<MessageEvent>((subscriber) => {
      const fn = (e: MessageEvent) => subscriber.next(e);
      if (!this.listeners.has(workspaceId)) this.listeners.set(workspaceId, new Set());
      this.listeners.get(workspaceId)!.add(fn);
      return () => this.listeners.get(workspaceId)?.delete(fn);
    });
    return merge(events, interval(25_000).pipe(map(() => ({ data: { type: 'heartbeat', at: new Date().toISOString() } }) as MessageEvent)));
  }

  list(ctx: RequestContext, unread: boolean) {
    return this.prisma.notification.findMany({
      where: { workspaceId: ctx.workspaceId, userId: ctx.userId, channel: 'in_app', createdAt: { gte: notificationCutoff() }, ...(unread ? { readAt: null } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async markRead(ctx: RequestContext, id: string) {
    await this.prisma.notification.updateMany({ where: { id, userId: ctx.userId }, data: { readAt: new Date() } });
    return { ok: true };
  }

  async markAllRead(ctx: RequestContext) {
    await this.prisma.notification.updateMany({ where: { userId: ctx.userId, readAt: null }, data: { readAt: new Date() } });
    return { ok: true };
  }

  /** Telegram bağlantısı için tek kullanımlık kod (10 dk). */
  async telegramCode(ctx: RequestContext) {
    const code = randomCode(8);
    await this.prisma.telegramLinkCode.create({ data: { userId: ctx.userId, code, expiresAt: new Date(Date.now() + 10 * 60_000) } });
    const bot = env().TELEGRAM_BOT_USERNAME;
    return {
      code,
      configured: !!env().TELEGRAM_BOT_TOKEN,
      botUsername: bot ?? null,
      deepLink: bot ? `https://t.me/${bot}?start=${code}` : null,
      expiresInSeconds: 600,
    };
  }

  async telegramUnlink(ctx: RequestContext) {
    await this.prisma.telegramLink.deleteMany({ where: { userId: ctx.userId } });
    return { ok: true };
  }
}

@Controller('v1')
export class NotificationsController {
  constructor(private readonly svc: NotificationsService) {}

  @Sse('events')
  events(@Ctx() ctx: RequestContext) {
    return this.svc.stream(ctx.workspaceId);
  }

  @Get('notifications')
  list(@Ctx() ctx: RequestContext, @Query('unread') unread?: string) {
    return this.svc.list(ctx, unread === 'true');
  }

  @Post('notifications/:id/read')
  read(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.svc.markRead(ctx, id);
  }

  @Post('notifications/read-all')
  readAll(@Ctx() ctx: RequestContext) {
    return this.svc.markAllRead(ctx);
  }

  @Post('telegram/link-code')
  telegramCode(@Ctx() ctx: RequestContext) {
    return this.svc.telegramCode(ctx);
  }

  @Post('telegram/unlink')
  unlink(@Ctx() ctx: RequestContext) {
    return this.svc.telegramUnlink(ctx);
  }
}

@Module({ controllers: [NotificationsController], providers: [NotificationsService] })
export class NotificationsModule {}
