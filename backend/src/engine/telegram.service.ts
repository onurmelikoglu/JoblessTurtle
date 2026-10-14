import { Injectable, Logger } from '@nestjs/common';
import { env } from '../common/env';
import { PrismaService } from '../common/prisma.service';
import { telegramCall } from './notify.service';

/**
 * Telegram bağlantısı: kullanıcı uygulamada tek kullanımlık kod üretir, bota "/start KOD" yazar.
 * Kod süresi, tek kullanım ve chat sahipliği doğrulanır. Long polling ile çalışır (webhook gerekmez).
 */
@Injectable()
export class TelegramService {
  private readonly logger = new Logger('Telegram');

  constructor(private readonly prisma: PrismaService) {}

  async pollOnce() {
    if (!env().TELEGRAM_BOT_TOKEN) return 0;
    const kv = await this.prisma.keyValue.findUnique({ where: { key: 'telegram:offset' } });
    const offset = (kv?.value as number | undefined) ?? 0;
    const updates: any[] = await telegramCall('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] });
    let next = offset;
    for (const u of updates) {
      next = Math.max(next, u.update_id + 1);
      const msg = u.message;
      if (!msg?.text || msg.chat?.type !== 'private') continue;
      await this.handle(String(msg.chat.id), msg.from?.username ?? null, String(msg.text).trim());
    }
    if (next !== offset) await this.prisma.keyValue.upsert({ where: { key: 'telegram:offset' }, create: { key: 'telegram:offset', value: next }, update: { value: next } });
    return updates.length;
  }

  async handle(chatId: string, username: string | null, text: string) {
    const m = text.match(/^\/start\s+([A-Z0-9]{6,12})$/i);
    if (m) {
      const code = m[1].toUpperCase();
      const row = await this.prisma.telegramLinkCode.findUnique({ where: { code } });
      if (!row || row.usedAt || row.expiresAt < new Date()) {
        await telegramCall('sendMessage', { chat_id: chatId, text: 'Kod geçersiz veya süresi dolmuş. Uygulamadan yeni kod oluşturun.' });
        return;
      }
      const taken = await this.prisma.telegramLink.findUnique({ where: { chatId } });
      if (taken && taken.userId !== row.userId) {
        await telegramCall('sendMessage', { chat_id: chatId, text: 'Bu Telegram hesabı başka bir kullanıcıya bağlı.' });
        return;
      }
      await this.prisma.$transaction([
        this.prisma.telegramLinkCode.update({ where: { id: row.id }, data: { usedAt: new Date() } }),
        this.prisma.telegramLink.upsert({ where: { userId: row.userId }, create: { userId: row.userId, chatId, username }, update: { chatId, username, linkedAt: new Date() } }),
      ]);
      await telegramCall('sendMessage', { chat_id: chatId, text: 'Bağlantı tamamlandı. Yeni uygun ilan, gönderim ve yanıt bildirimleri buraya gelecek.' });
      return;
    }
    if (/^\/(help|start)$/.test(text)) {
      await telegramCall('sendMessage', { chat_id: chatId, text: 'Bağlanmak için uygulamada Hesaplar ve bildirimler → Telegram bağla adımındaki kodu "/start KOD" olarak gönderin.' });
    }
  }
}
