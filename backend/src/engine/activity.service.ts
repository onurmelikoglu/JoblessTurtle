import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { env } from '../common/env';
import { PrismaService } from '../common/prisma.service';
import { istanbulNow } from '../common/time';
import { ActivityCounts, activityOfAiKind, activityOfOutboxEvent, mergeActivity } from '../domain/activity';

const SNAPSHOT_KEY = 'worker:activity';
const SNAPSHOT_FRESH_MS = 60_000;
const AI_TASK_GRACE_MS = 5 * 60_000;
const PREDRAFT_SCHEDULE_KEY = 'sched:predraft';
export const PREDRAFT_EVERY_MS = 10 * 60_000;
export const DAILY_DISCOVERY_HOUR = 3;

interface ActivitySnapshot {
  at: string;
  workspaces: Record<string, ActivityCounts>;
}

function increment(counts: ActivityCounts, bucket: keyof ActivityCounts, field: 'running' | 'queued', by: number) {
  const entry = counts[bucket] ?? { running: 0, queued: 0 };
  entry[field] += by;
  counts[bucket] = entry;
}

/** Bir AI görevi sağlayıcı zaman aşımından daha uzun süre "çalışıyor" kalamaz; kalan kayıt yarıda kesilmiş bir iştir. */
function aiTaskStaleMs() {
  return env().AI_CLI_TIMEOUT_SECONDS * 1000 + AI_TASK_GRACE_MS;
}

/**
 * Çalışma alanı başına gerçekten çalışan ve kuyrukta bekleyen işler. Kuyruk derinliği worker'ın
 * periyodik anlık görüntüsünden, anlık sinyaller (çalışan AI görevi, gönderilen mail, henüz dağıtılmamış olay)
 * veritabanından gelir.
 */
@Injectable()
export class ActivityService {
  private readonly logger = new Logger('Activity');

  constructor(private readonly prisma: PrismaService) {}

  async saveSnapshot(workspaces: Record<string, ActivityCounts>) {
    const value = { at: new Date().toISOString(), workspaces } as unknown as Prisma.InputJsonValue;
    await this.prisma.keyValue.upsert({ where: { key: SNAPSHOT_KEY }, create: { key: SNAPSHOT_KEY, value }, update: { value } });
  }

  async counts(workspaceId: string, now = new Date()): Promise<{ counts: ActivityCounts; workerOnline: boolean }> {
    const [kv, aiRunning, sending, pendingEvents] = await Promise.all([
      this.prisma.keyValue.findUnique({ where: { key: SNAPSHOT_KEY } }),
      this.prisma.aiTask.groupBy({ by: ['kind'], where: { workspaceId, status: 'running', createdAt: { gte: new Date(now.getTime() - aiTaskStaleMs()) } }, _count: true }),
      this.prisma.applicationAttempt.count({ where: { workspaceId, state: 'sending' } }),
      this.prisma.outboxEvent.groupBy({ by: ['eventType'], where: { workspaceId, processingState: 'pending', availableAt: { lte: now } }, _count: true }),
    ]);
    const snapshot = kv?.value as unknown as ActivitySnapshot | null;
    const workerOnline = !!snapshot && now.getTime() - new Date(snapshot.at).getTime() < SNAPSHOT_FRESH_MS;
    const live: ActivityCounts = {};
    for (const row of aiRunning) {
      const kind = activityOfAiKind(row.kind);
      if (kind) increment(live, kind, 'running', row._count);
    }
    if (sending) increment(live, 'send', 'running', sending);
    for (const row of pendingEvents) {
      const kind = activityOfOutboxEvent(row.eventType);
      if (kind) increment(live, kind, 'queued', row._count);
    }
    return { counts: mergeActivity(workerOnline ? (snapshot!.workspaces[workspaceId] ?? {}) : {}, live), workerOnline };
  }

  /** Son ve sıradaki otomatik işler: kaynak taraması, gece keşfi ve arka plan yazı hazırlığı. */
  async schedule(workspaceId: string, opts: { dailyDiscovery: boolean; paused: boolean; lettersPending: boolean }, now = new Date()) {
    const [sources, lastDiscovery, predraft] = await Promise.all([
      this.prisma.sourceConnector.aggregate({
        where: { workspaceId, enabled: true, health: { not: 'blocked' }, accessMode: { not: 'manual' } },
        _count: true,
        _max: { lastRunAt: true },
        _min: { nextRunAt: true },
      }),
      this.prisma.aiTask.findFirst({ where: { workspaceId, kind: 'company_discovery', status: 'succeeded' }, orderBy: { createdAt: 'desc' }, select: { completedAt: true, createdAt: true } }),
      opts.lettersPending ? this.prisma.keyValue.findUnique({ where: { key: PREDRAFT_SCHEDULE_KEY } }) : null,
    ]);
    const local = istanbulNow(now);
    const todayRun = local.set({ hour: DAILY_DISCOVERY_HOUR, minute: 0, second: 0, millisecond: 0 });
    const lastPredraftAt = (predraft?.value as { at?: string } | null)?.at;
    return {
      sources: sources._count,
      lastScanAt: sources._max.lastRunAt,
      nextScanAt: opts.paused ? null : sources._min.nextRunAt,
      lastDiscoveryAt: lastDiscovery?.completedAt ?? lastDiscovery?.createdAt ?? null,
      nextDiscoveryAt: opts.dailyDiscovery && !opts.paused ? (todayRun > local ? todayRun : todayRun.plus({ days: 1 })).toJSDate() : null,
      nextPrepAt: lastPredraftAt && !opts.paused ? new Date(new Date(lastPredraftAt).getTime() + PREDRAFT_EVERY_MS) : null,
    };
  }

  async reapStuckAiTasks(now = new Date()) {
    const r = await this.prisma.aiTask.updateMany({
      where: { status: 'running', createdAt: { lt: new Date(now.getTime() - aiTaskStaleMs()) } },
      data: { status: 'failed', error: 'Zaman aşımı: görev tamamlanmadan yarıda kesildi' },
    });
    if (r.count) this.logger.warn(`${r.count} yarım kalmış AI görevi kapatıldı`);
    return r.count;
  }
}
