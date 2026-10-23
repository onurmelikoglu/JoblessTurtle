import { Controller, Delete, Get, Injectable, MessageEvent, Module, OnModuleDestroy, Param, Post, Query, Sse } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import Redis from 'ioredis';
import { interval, map, merge, Observable } from 'rxjs';
import { z, ZodSchema } from 'zod';
import { Ctx, RequestContext } from '../../common/auth';
import { randomCode } from '../../common/crypto';
import { env } from '../../common/env';
import { AppError, notFound } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { ZodPipe } from '../../common/zod.pipe';
import type { NotificationDeleteResult, NotificationPage } from '../../contracts/notifications';
import type { ServerShape } from '../../contracts/wire';
import {
  clearSince,
  decodeNotificationCursor,
  encodeNotificationCursor,
  FOLD_FROM,
  FOLD_TO,
  listWindow,
  NOTIFICATION_CLEAR_RANGES,
  NotificationClearRange,
  searchTokens,
} from '../../domain/notifications';
import { notificationCutoff } from '../../engine/notify.service';

export const EVENTS_CHANNEL = (ws: string) => `events:${ws}`;

const isoDate = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), 'ISO-8601 tarih bekleniyor')
  .transform((v) => new Date(v));
const flag = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');

const listQuery = z
  .object({
    q: z.string().max(200).optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    unread: flag.optional(),
    cursor: z.string().max(80).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, { message: 'Başlangıç, bitişten sonra olamaz', path: ['from'] });
type ListQuery = z.infer<typeof listQuery>;
/** Dönüştürülen alanlar (tarih, bayrak) yüzünden giriş ve çıkış tipi farklıdır; boru çıkış tipini verir. */
const listPipe = () => new ZodPipe<ListQuery>(listQuery as unknown as ZodSchema<ListQuery>);

const clearQuery = z.object({ range: z.enum(NOTIFICATION_CLEAR_RANGES) });

const ITEM_FIELDS = { id: true, type: true, title: true, body: true, link: true, readAt: true, createdAt: true } as const;
/** Başlık ve gövde, arama sözcükleriyle aynı biçimde sadeleştirilir (bkz. `searchTokens`). */
const FOLDED_TEXT = Prisma.sql`lower(translate(concat_ws(' ', "title", "body"), ${FOLD_FROM}, ${FOLD_TO}))`;

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

  /** Kullanıcının bu çalışma alanındaki uygulama içi bildirimleri; Telegram teslim kayıtları hiçbir işleme girmez. */
  private own(ctx: RequestContext) {
    return { workspaceId: ctx.workspaceId, userId: ctx.userId, channel: 'in_app' } satisfies Prisma.NotificationWhereInput;
  }

  /** Son 30 günün bildirimleri: metin araması, tarih-saat aralığı, okunmamış süzgeci; en yeni önce, imleçle sayfalanır. */
  async list(ctx: RequestContext, q: ListQuery): Promise<ServerShape<NotificationPage>> {
    const cursor = q.cursor ? decodeNotificationCursor(q.cursor) : null;
    if (q.cursor && !cursor) throw new AppError(400, 'VALIDATION_FAILED', 'Geçersiz sayfa imleci');
    const cutoff = notificationCutoff();
    const where: Prisma.NotificationWhereInput = { ...this.own(ctx), createdAt: listWindow(cutoff, q.from, q.to), ...(q.unread ? { readAt: null } : {}) };
    const tokens = searchTokens(q.q);
    if (tokens.length) where.id = { in: await this.matchingIds(ctx, cutoff, tokens) };
    const after: Prisma.NotificationWhereInput = cursor ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] } : {};
    const [rows, total, unread] = await Promise.all([
      this.prisma.notification.findMany({ where: { AND: [where, after] }, select: ITEM_FIELDS, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: q.limit + 1 }),
      this.prisma.notification.count({ where }),
      this.prisma.notification.count({ where: { ...this.own(ctx), createdAt: { gte: cutoff }, readAt: null } }),
    ]);
    const items = rows.slice(0, q.limit);
    return { items, total, unread, next_cursor: rows.length > q.limit ? encodeNotificationCursor(items[items.length - 1]) : null };
  }

  /** Her arama sözcüğü başlıkta ya da gövdede geçen bildirimlerin kimlikleri. */
  private async matchingIds(ctx: RequestContext, cutoff: Date, tokens: string[]) {
    const matches = Prisma.join(tokens.map((token) => Prisma.sql`${FOLDED_TEXT} LIKE ${`%${token}%`}`), ' AND ');
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Notification"
      WHERE "workspaceId" = ${ctx.workspaceId} AND "userId" = ${ctx.userId} AND "channel" = 'in_app' AND "createdAt" >= ${cutoff} AND ${matches}`;
    return rows.map((r) => r.id);
  }

  /** Geçmişi temizler: son 1 saat / 24 saat / 7 gün içinde gelenler ya da hepsi. */
  async clear(ctx: RequestContext, range: NotificationClearRange): Promise<NotificationDeleteResult> {
    const since = clearSince(range);
    const { count } = await this.prisma.notification.deleteMany({ where: { ...this.own(ctx), ...(since ? { createdAt: { gte: since } } : {}) } });
    return { deleted: count };
  }

  async remove(ctx: RequestContext, id: string): Promise<NotificationDeleteResult> {
    const { count } = await this.prisma.notification.deleteMany({ where: { ...this.own(ctx), id } });
    if (!count) throw notFound('Bildirim');
    return { deleted: count };
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
  list(@Ctx() ctx: RequestContext, @Query(listPipe()) q: ListQuery) {
    return this.svc.list(ctx, q);
  }

  @Delete('notifications')
  clear(@Ctx() ctx: RequestContext, @Query(new ZodPipe(clearQuery)) q: z.infer<typeof clearQuery>) {
    return this.svc.clear(ctx, q.range);
  }

  @Delete('notifications/:id')
  remove(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.svc.remove(ctx, id);
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
