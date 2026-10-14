import { Injectable } from '@nestjs/common';
import { PrismaService, Tx } from './prisma.service';
import { istanbulDay } from './time';

/**
 * Günlük sayaçlar (gönderim limiti, AI görev bütçesi). Rezervasyon transaction içinde
 * satır güncellemesiyle yapılır; limit aşılırsa false döner ve sayaç artmaz.
 */
@Injectable()
export class UsageService {
  constructor(private readonly prisma: PrismaService) {}

  async reserve(workspaceId: string, key: string, limit: number, tx?: Tx, now = new Date()): Promise<boolean> {
    const db = tx ?? this.prisma;
    const day = istanbulDay(now);
    await db.usageCounter.upsert({
      where: { workspaceId_key_day: { workspaceId, key, day } },
      create: { workspaceId, key, day, count: 0 },
      update: {},
    });
    const updated = await db.usageCounter.updateMany({
      where: { workspaceId, key, day, count: { lt: limit } },
      data: { count: { increment: 1 } },
    });
    return updated.count === 1;
  }

  async release(workspaceId: string, key: string, tx?: Tx, now = new Date()) {
    const db = tx ?? this.prisma;
    await db.usageCounter.updateMany({
      where: { workspaceId, key, day: istanbulDay(now), count: { gt: 0 } },
      data: { count: { decrement: 1 } },
    });
  }

  async get(workspaceId: string, key: string, now = new Date()) {
    const row = await this.prisma.usageCounter.findUnique({
      where: { workspaceId_key_day: { workspaceId, key, day: istanbulDay(now) } },
    });
    return row?.count ?? 0;
  }
}
