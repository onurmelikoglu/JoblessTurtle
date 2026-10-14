import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { env } from '../common/env';
import { PrismaService } from '../common/prisma.service';
import { hhmmToMinutes, istanbulDay, istanbulNow } from '../common/time';

export interface NotifyPayload {
  type: string;
  title: string;
  body?: string;
  link?: string;
  score?: number | null;
}

/** Push/Telegram içeriğinde CV ve özel alıcı bilgisi varsayılan gösterilmez. */
function sanitize(text: string | undefined) {
  if (!text) return '';
  return text.replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, '[e-posta]').slice(0, 800);
}

function inQuietHours(settings: any, now = new Date()) {
  if (!settings?.quietStart || !settings?.quietEnd) return false;
  const t = istanbulNow(now);
  const m = t.hour * 60 + t.minute;
  const s = hhmmToMinutes(settings.quietStart);
  const e = hhmmToMinutes(settings.quietEnd);
  return s <= e ? m >= s && m < e : m >= s || m < e;
}

@Injectable()
export class NotifyService {
  private readonly logger = new Logger('Notify');

  constructor(private readonly prisma: PrismaService) {}

  /** Aynı olay event_id ile tekilleştirilir; Telegram yeniden denemeleri e-postayı yeniden göndermez. */
  async notify(workspaceId: string, eventId: string, p: NotifyPayload) {
    const members = await this.prisma.membership.findMany({ where: { workspaceId }, include: { user: { include: { telegramLink: true } } } });
    for (const m of members) {
      const settings = (m.user.notificationSettings ?? {}) as any;
      if (settings.types && settings.types[p.type] === false) continue;
      const inAppId = `${eventId}:${m.userId}`;
      try {
        await this.prisma.notification.create({
          data: { workspaceId, userId: m.userId, eventId: inAppId, type: p.type, title: p.title, body: p.body ?? null, link: p.link ?? null, channel: 'in_app', deliveredAt: new Date() },
        });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') continue; // zaten bildirildi
        throw e;
      }
      const telegramAllowed =
        m.user.telegramLink &&
        settings.telegramEnabled !== false &&
        (settings.mode !== 'digest' || p.type === 'daily_digest' || ['send_unknown', 'source_blocked', 'human_reply', 'interview'].includes(p.type)) &&
        !(inQuietHours(settings) && p.type !== 'daily_digest') &&
        !(typeof settings.minScore === 'number' && typeof p.score === 'number' && p.score < settings.minScore);
      if (telegramAllowed) await this.sendTelegram(workspaceId, m.userId, m.user.telegramLink!.chatId, `${eventId}:${m.userId}`, p);
    }
  }

  private async sendTelegram(workspaceId: string, userId: string, chatId: string, eventId: string, p: NotifyPayload) {
    const token = env().TELEGRAM_BOT_TOKEN;
    if (!token) return;
    let row;
    try {
      row = await this.prisma.notification.create({ data: { workspaceId, userId, eventId, type: p.type, title: p.title, body: p.body ?? null, link: p.link ?? null, channel: 'telegram' } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return;
      throw e;
    }
    const link = p.link ? `${env().APP_PUBLIC_URL.replace(/\/$/, '')}/#${p.link}` : null;
    const text = `<b>${escapeHtml(p.title)}</b>\n${escapeHtml(sanitize(p.body))}${link ? `\n\n<a href="${link}">Uygulamada aç</a>` : ''}`;
    try {
      await telegramCall('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });
      await this.prisma.notification.update({ where: { id: row.id }, data: { deliveredAt: new Date() } });
    } catch (e) {
      // Bildirim kanalı hatası başvuruyu başarısız saymaz.
      await this.prisma.notification.update({ where: { id: row.id }, data: { error: (e as Error).message.slice(0, 300) } });
    }
  }

  async dailyDigest(workspaceId: string, now = new Date()) {
    const since = new Date(now.getTime() - 24 * 3600_000);
    const [opps, sent, replies, unknown, blockedSources, pending] = await Promise.all([
      this.prisma.opportunity.count({ where: { workspaceId, createdAt: { gte: since }, category: { in: ['target_open', 'adjacent_open'] } } }),
      this.prisma.applicationAttempt.count({ where: { workspaceId, acceptedAt: { gte: since } } }),
      this.prisma.inboundMessage.count({ where: { workspaceId, receivedAt: { gte: since } } }),
      this.prisma.applicationAttempt.count({ where: { workspaceId, state: 'submission_unknown' } }),
      this.prisma.sourceConnector.count({ where: { workspaceId, health: { in: ['blocked', 'degraded'] } } }),
      this.prisma.applicationDraft.count({ where: { workspaceId, status: { in: ['draft', 'needs_review'] } } }),
    ]);
    const body = [
      `Yeni uygun ilan: ${opps}`,
      `Sağlayıcı kabulü alan gönderim: ${sent}`,
      `Gelen yanıt: ${replies}`,
      `Bekleyen taslak: ${pending}`,
      unknown ? `Sonucu belirsiz gönderim: ${unknown}` : null,
      blockedSources ? `Sorunlu kaynak: ${blockedSources}` : null,
    ]
      .filter(Boolean)
      .join('\n');
    await this.notify(workspaceId, `digest:${workspaceId}:${istanbulDay(now)}`, { type: 'daily_digest', title: 'Günlük özet', body, link: '/' });
  }
}

export function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function telegramCall(method: string, body: Record<string, unknown>) {
  const token = env().TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN tanımlı değil');
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(40_000),
  });
  const data: any = await res.json();
  if (!data.ok) throw new Error(data.description ?? `Telegram HTTP ${res.status}`);
  return data.result;
}
