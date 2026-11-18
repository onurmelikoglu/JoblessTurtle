import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { OutboxService } from '../common/outbox.service';
import { PrismaService } from '../common/prisma.service';
import { MANUAL_ONLY_KINDS } from '../domain/contact-research';
import { SENDABLE_CONTACT_KINDS } from '../domain/contacts';
import { ACTIVE_ITEM_STATES, batchProgress, BatchItemState, CompanySnapshot, fieldsFound, itemStateOf, ResearchOutcome, STUCK_RUNNING_MS } from '../domain/research-batch';
import { AiService } from './ai/ai.service';
import { withAiClass } from './ai/ai-context';
import { ResearchService } from './research.service';

export type BatchOrigin = 'user' | 'autopilot';

/**
 * Kullanıcının başlattığı toplu firma araştırması. Her firma ayrı bir öğedir; öğeler "enrich" kuyruğunda kendi
 * günlük kotasıyla çalışır. Kota dolduğunda öğe silinmez, "ertelendi" olur ve kota açılınca kaldığı yerden sürer.
 */
@Injectable()
export class ResearchBatchService {
  private readonly logger = new Logger('ResearchBatch');

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly ai: AiService,
    private readonly research: ResearchService,
  ) {}

  /** Aynı firma, sürmekte olan başka bir işte zaten sıradaysa yeniden eklenmez. */
  async start(workspaceId: string, companyIds: string[], opts: { userId: string | null; force?: boolean; origin?: BatchOrigin; context?: Record<string, unknown> }) {
    const owned = await this.prisma.company.findMany({ where: { id: { in: [...new Set(companyIds)] }, workspaceId }, select: { id: true } });
    const busy = await this.prisma.researchBatchItem.findMany({
      where: { companyId: { in: owned.map((c) => c.id) }, state: { in: ACTIVE_ITEM_STATES }, batch: { status: 'running' } },
      select: { companyId: true },
    });
    const busyIds = new Set(busy.map((b) => b.companyId));
    const fresh = owned.map((c) => c.id).filter((id) => !busyIds.has(id));
    if (!fresh.length) return { batchId: null, queued: 0, alreadyQueued: busyIds.size };
    const batch = await this.prisma.researchBatch.create({
      data: {
        workspaceId,
        createdById: opts.userId,
        origin: opts.origin ?? 'user',
        force: opts.force === true,
        items: { create: fresh.map((companyId) => ({ companyId, context: (opts.context ?? {}) as Prisma.InputJsonValue })) },
      },
    });
    await this.outbox.emit({ workspaceId, eventType: 'research.batch', aggregateId: batch.id, dedupKey: `research-batch:${batch.id}`, payload: { userTriggered: true } });
    return { batchId: batch.id, queued: fresh.length, alreadyQueued: busyIds.size };
  }

  async queuedItems(batchId: string) {
    return this.prisma.researchBatchItem.findMany({ where: { batchId, state: 'queued' }, select: { id: true, attempts: true } });
  }

  async runItem(itemId: string) {
    const item = await this.prisma.researchBatchItem.findUnique({ where: { id: itemId }, include: { batch: true } });
    if (!item || item.batch.status !== 'running' || !['queued', 'deferred'].includes(item.state)) return { status: 'skipped' as const };
    if (!(await this.ai.classOpen(item.batch.workspaceId, 'enrich'))) {
      await this.settle(item.id, 'deferred', [], await this.ai.unavailableReason(item.batch.workspaceId, 'enrich'));
      return { status: 'deferred' as const };
    }
    await this.prisma.researchBatchItem.update({ where: { id: item.id }, data: { state: 'running', startedAt: new Date(), attempts: { increment: 1 } } });
    const before = await this.snapshot(item.companyId);
    let outcome: ResearchOutcome;
    try {
      const avoidEmails = ((item.context ?? {}) as { avoidEmails?: string[] }).avoidEmails ?? [];
      const run = await withAiClass('enrich', () => this.research.findDetails(item.companyId, item.batch.createdById, { deep: true, force: item.batch.force, avoidEmails }));
      outcome = run.value as ResearchOutcome;
    } catch (e) {
      this.logger.warn(`Firma araştırması başarısız (${item.companyId}): ${(e as Error).message}`);
      outcome = { status: 'failed', reason: (e as Error).message.slice(0, 200) };
    }
    const after = await this.snapshot(item.companyId);
    const found = before && after ? fieldsFound(before, after) : [];
    const settled = itemStateOf(outcome, found, item.attempts + 1);
    const { state } = settled;
    const note = state === 'deferred' ? await this.ai.unavailableReason(item.batch.workspaceId, 'enrich') : settled.note;
    await this.settle(item.id, state, found, note);
    await this.finishIfDone(item.batchId);
    return { status: state, found };
  }

  /** Kotası açılan çalışma alanlarının ertelenmiş öğeleri ve yarıda kalmış (worker kapanmış) öğeler yeniden sıraya alınır. */
  async resumable(now = new Date()): Promise<{ id: string; attempts: number }[]> {
    await this.prisma.researchBatchItem.updateMany({
      where: { state: 'running', startedAt: { lt: new Date(now.getTime() - STUCK_RUNNING_MS) }, batch: { status: 'running' } },
      data: { state: 'queued', note: 'Yarıda kaldı; yeniden deneniyor' },
    });
    const items = await this.prisma.researchBatchItem.findMany({
      where: { state: { in: ['deferred', 'queued'] }, batch: { status: 'running' } },
      select: { id: true, state: true, attempts: true, batch: { select: { workspaceId: true } } },
    });
    const open = new Map<string, boolean>();
    const out: { id: string; attempts: number }[] = [];
    for (const item of items) {
      const ws = item.batch.workspaceId;
      if (!open.has(ws)) {
        const isOpen = await this.ai.classOpen(ws, 'enrich');
        open.set(ws, isOpen);
        if (!isOpen) await this.prisma.researchBatchItem.updateMany({ where: { state: 'deferred', batch: { workspaceId: ws, status: 'running' } }, data: { note: await this.ai.unavailableReason(ws, 'enrich') } });
      }
      if (!open.get(ws)) continue;
      if (item.state === 'deferred') await this.prisma.researchBatchItem.update({ where: { id: item.id }, data: { state: 'queued' } });
      out.push({ id: item.id, attempts: item.attempts });
    }
    return out;
  }

  async cancel(workspaceId: string) {
    const batches = await this.prisma.researchBatch.findMany({ where: { workspaceId, status: 'running', origin: 'user' }, select: { id: true } });
    const ids = batches.map((b) => b.id);
    if (!ids.length) return { cancelled: 0 };
    const { count } = await this.prisma.researchBatchItem.updateMany({ where: { batchId: { in: ids }, state: { in: ['queued', 'deferred'] } }, data: { state: 'skipped', note: 'Durduruldu', finishedAt: new Date() } });
    for (const id of ids) await this.finishIfDone(id);
    return { cancelled: count };
  }

  /** Ekrandaki ilerleme: sürmekte olan iş ya da son bir saatte biten iş. */
  async current(workspaceId: string, now = new Date()) {
    const batch = await this.prisma.researchBatch.findFirst({
      where: { workspaceId, origin: 'user', OR: [{ status: 'running' }, { finishedAt: { gte: new Date(now.getTime() - 3600_000) } }] },
      orderBy: { createdAt: 'desc' },
      include: { items: { select: { companyId: true, state: true, found: true, note: true } } },
    });
    if (!batch) return null;
    const status: 'running' | 'done' | 'cancelled' = batch.status === 'done' ? 'done' : batch.status === 'cancelled' ? 'cancelled' : 'running';
    return { id: batch.id, status, startedAt: batch.createdAt, finishedAt: batch.finishedAt, ...batchProgress(batch.items) };
  }

  private async settle(itemId: string, state: BatchItemState, found: string[], note: string | null) {
    await this.prisma.researchBatchItem.update({ where: { id: itemId }, data: { state, found, note, ...(ACTIVE_ITEM_STATES.includes(state) ? {} : { finishedAt: new Date() }) } });
  }

  private async finishIfDone(batchId: string) {
    const remaining = await this.prisma.researchBatchItem.count({ where: { batchId, state: { in: ACTIVE_ITEM_STATES } } });
    if (remaining) return;
    const closed = await this.prisma.researchBatch.updateMany({ where: { id: batchId, status: 'running' }, data: { status: 'done', finishedAt: new Date() } });
    if (!closed.count) return;
    const batch = await this.prisma.researchBatch.findUniqueOrThrow({ where: { id: batchId }, include: { items: { select: { companyId: true, state: true, found: true, note: true, context: true } } } });
    if (batch.origin === 'autopilot') {
      for (const item of batch.items) {
        const messageId = (item.context as { messageId?: string } | null)?.messageId;
        if (messageId) await this.outbox.emit({ workspaceId: batch.workspaceId, eventType: 'autopilot.research_done', aggregateId: messageId, dedupKey: `autopilot-research:${messageId}:${batchId}`, payload: { companyId: item.companyId } });
      }
      return;
    }
    const p = batchProgress(batch.items);
    const parts = [`${p.total} firmadan ${p.found.email} tanesinde mail adresi bulundu`];
    const extras = [p.found.office && `${p.found.office} ofis adresi`, p.found.employees && `${p.found.employees} çalışan sayısı`, p.found.phone && `${p.found.phone} telefon`].filter(Boolean);
    if (extras.length) parts.push(`ayrıca ${extras.join(', ')}`);
    if (p.skipped) parts.push(`${p.skipped} firma yakın zamanda arandığı için atlandı`);
    await this.outbox.emit({
      workspaceId: batch.workspaceId,
      eventType: 'notify',
      aggregateId: batch.id,
      dedupKey: `research-batch-done:${batch.id}`,
      payload: { type: 'research_done', title: 'Firma araştırması bitti', body: `${parts.join('; ')}.`, link: '/' },
    });
  }

  private async snapshot(companyId: string): Promise<CompanySnapshot | null> {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { employeeRange: true, phone: true, workPolicy: true, linkedinUrl: true, canonicalDomain: true, website: true },
    });
    if (!company) return null;
    const [sendable, manual, offices] = await Promise.all([
      this.prisma.contactPoint.count({ where: { companyId, suppressed: false, kind: { in: SENDABLE_CONTACT_KINDS } } }),
      this.prisma.contactPoint.count({ where: { companyId, suppressed: false, kind: { in: MANUAL_ONLY_KINDS } } }),
      this.prisma.office.count({ where: { companyId, locationConfidence: { in: ['medium', 'high'] } } }),
    ]);
    return {
      sendable,
      manual,
      offices,
      employees: !!company.employeeRange,
      phone: !!company.phone,
      workPolicy: !!company.workPolicy,
      linkedin: !!company.linkedinUrl,
      website: !!(company.canonicalDomain || company.website),
    };
  }
}
