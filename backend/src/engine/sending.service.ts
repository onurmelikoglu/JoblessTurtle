import { Injectable, Logger } from '@nestjs/common';
import { ApplicationAttempt, Prisma } from '@prisma/client';
import { AuditService } from '../common/audit.service';
import { hashObject } from '../common/crypto';
import { env } from '../common/env';
import { AppError, notFound } from '../common/errors';
import { OutboxService } from '../common/outbox.service';
import { PrismaService, Tx } from '../common/prisma.service';
import { StorageService } from '../common/storage.service';
import { addBusinessDays, istanbulDay, nextDaySendSlot } from '../common/time';
import { UsageService } from '../common/usage.service';
import { activeKeyFor, holdsActiveKey } from '../domain/attempt-state';
import { isValidEmail, NON_RECIPIENT_KINDS } from '../domain/contacts';
import { normalizeDomain } from '../domain/text';
import { checkDraftContent, IntentType } from '../domain/templates';
import { AddressBookService } from './address-book.service';
import { DraftingService, verifiedFactsText } from './drafting.service';
import { IngestService } from './ingest.service';
import { estimateRawSize, MAX_RAW_BYTES, MailDefiniteError, mailProviderFor, MailUnknownError } from './mail/providers';

/** autopilot: geri dönen başvurunun kullanıcıya sorulmadan yapılan düzeltmesi; otomatik gönderimin adres ve ilan koşullarına uyar. */
export type SendMode = 'manual' | 'campaign' | 'auto' | 'autopilot';

/** Önceki başvurunun yerine geçen gönderimler firma bekleme süresine takılmaz. */
const COOLDOWN_OVERRIDE_MODES: SendMode[] = ['manual', 'autopilot'];

export interface QueueSendInput {
  workspaceId: string;
  userId: string | null;
  draftId: string;
  idempotencyKey: string;
  expectedRevision?: number;
  mailAccountId?: string | null;
  sendMode: SendMode;
  policyVersionId?: string | null;
  campaignId?: string | null;
  scheduledAt?: Date | null;
  overrideCooldown?: boolean;
}

const ACTIVE_STATES = ['queued', 'sending', 'provider_accepted', 'submission_unknown', 'replied', 'bounced', 'outcome_recorded'];
const NOT_SENT_STATES = ['cancelled', 'blocked', 'failed_confirmed'];

const PACING_KEY_PREFIX = 'send:pace:';
const SEND_GAP_MIN_MS = 30_000;
const SEND_GAP_MAX_MS = 50_000;
const PACING_JITTER_MS = 2_000;

@Injectable()
export class SendingService {
  private readonly logger = new Logger('Sending');

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly usage: UsageService,
    private readonly storage: StorageService,
    private readonly drafting: DraftingService,
    private readonly ingest: IngestService,
    private readonly addressBook: AddressBookService,
  ) {}

  /** Adres sicili yardımcı kayıttır; işlenememesi gönderimin sonucunu değiştirmez. */
  private async noteSent(attemptId: string) {
    await this.addressBook.noteSent(attemptId).catch((e) => this.logger.warn(`Adres sicili güncellenemedi (${attemptId}): ${(e as Error).message}`));
  }

  async isSuppressed(workspaceId: string, candidateId: string, companyId: string, email: string | null, tx?: Tx) {
    const db = tx ?? this.prisma;
    const domain = email ? normalizeDomain(email.split('@')[1]) : null;
    const s = await db.suppression.findFirst({
      where: {
        workspaceId,
        AND: [
          { OR: [{ candidateId: null }, { candidateId }] },
          {
            OR: [
              { companyId },
              ...(email ? [{ contactEmail: email.toLowerCase() }] : []),
              ...(domain ? [{ domain }] : []),
            ],
          },
        ],
      },
    });
    return s;
  }

  async companyCooldownActive(candidateId: string, companyId: string, days: number, excludeAttemptId?: string, tx?: Tx) {
    const db = tx ?? this.prisma;
    const since = new Date(Date.now() - days * 86400_000);
    const n = await db.applicationAttempt.count({
      where: { candidateId, companyId, state: { in: ACTIVE_STATES }, queuedAt: { gte: since }, intentType: { not: 'follow_up' }, ...(excludeAttemptId ? { id: { not: excludeAttemptId } } : {}) },
    });
    return n > 0;
  }

  /**
   * Gönder komutu: mevcut taslak sürümünü sabitler, tekrar ve dosya kontrollerini çalıştırır, kuyruğa yazar.
   * Yanıt "queued" durumudur; sağlayıcı kabulü daha sonra olay olarak gelir.
   */
  async queueSend(input: QueueSendInput): Promise<{ attempt: ApplicationAttempt; reused: boolean }> {
    if (!input.idempotencyKey || input.idempotencyKey.length < 8) throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key başlığı gerekli');
    const draft = await this.prisma.applicationDraft.findFirst({ where: { id: input.draftId, workspaceId: input.workspaceId } });
    if (!draft) throw notFound('Taslak');
    const mailAccountId = input.mailAccountId ?? draft.mailAccountId;
    const requestHash = hashObject({ draftId: draft.id, revision: input.expectedRevision ?? draft.currentRevision, mailAccountId, sendMode: input.sendMode });

    const existing = await this.prisma.applicationAttempt.findUnique({ where: { workspaceId_idempotencyKey: { workspaceId: input.workspaceId, idempotencyKey: input.idempotencyKey } } });
    if (existing) {
      if (existing.requestHash !== requestHash) throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'Aynı Idempotency-Key farklı içerikle kullanıldı');
      return { attempt: existing, reused: true };
    }

    if (input.expectedRevision !== undefined && input.expectedRevision !== draft.currentRevision)
      throw new AppError(409, 'DOCUMENT_CHANGED', 'Taslak onaylandıktan sonra değişti; güncel sürümü inceleyin', { current: draft.currentRevision });
    if (!['draft', 'needs_review'].includes(draft.status)) throw new AppError(409, 'DRAFT_NOT_SENDABLE', `Taslak durumu gönderime uygun değil (${draft.status})`);
    const rev = await this.drafting.currentRevision(draft.id);
    if (!rev) throw new AppError(422, 'DRAFT_EMPTY', 'Taslakta içerik yok');
    if (!rev.toEmail || !isValidEmail(rev.toEmail)) throw new AppError(422, 'RECIPIENT_MISSING', 'Geçerli bir alıcı adresi yok');
    // İçerik kuralları gönderim anında yeniden hesaplanır; taslaktaki operasyonel gerekçeler (ör. EMERGENCY_STOP) engel değildir.
    const cand = await this.prisma.candidateProfile.findUniqueOrThrow({ where: { id: draft.candidateId } });
    const content = checkDraftContent({
      intent: draft.intentType as IntentType,
      subject: rev.subject,
      body: rev.body,
      verifiedFactsText: verifiedFactsText(cand),
      allowedEmails: [cand.email ?? '', rev.toEmail].filter(Boolean),
    });
    if (!content.ok) throw new AppError(422, 'DRAFT_RULES_FAILED', 'Taslak içerik kurallarına uymuyor', content.problems);

    if (!mailAccountId) throw new AppError(422, 'ACCOUNT_MISSING', 'Gönderici hesabı seçilmedi');
    const account = await this.prisma.mailAccount.findFirst({ where: { id: mailAccountId, workspaceId: input.workspaceId } });
    if (!account || account.candidateId !== draft.candidateId)
      throw new AppError(403, 'ACCOUNT_NOT_OWNED', 'Gönderici hesabı bu adaya ait değil; başka adayın hesabı kullanılamaz');
    if (account.health !== 'ok') throw new AppError(422, 'ACCOUNT_UNHEALTHY', 'Gönderici hesabı yeniden bağlanmalı');

    if (await this.addressBook.isDead(rev.toEmail)) throw new AppError(422, 'DEAD_ADDRESS', 'Bu adres geçersiz olduğu için bir daha kullanılmıyor; başka bir adres seç');
    const contact = await this.prisma.contactPoint.findFirst({ where: { companyId: draft.companyId, email: rev.toEmail.toLowerCase() } });
    if (contact?.kind === 'guessed') throw new AppError(422, 'CONTACT_UNVERIFIED', 'Tahmin edilmiş adrese gönderim yapılmaz; adresi doğrulayın');
    if (contact?.suppressed) throw new AppError(422, 'SUPPRESSED', 'Bu adrese gönderim engelli (geri dönme veya kullanıcı engeli)');
    if (input.sendMode !== 'manual' && (!contact || !contact.verifiedAt))
      throw new AppError(422, 'CONTACT_UNVERIFIED', 'Toplu/otomatik gönderim için alıcı adresi doğrulanmış olmalı');

    const suppressed = await this.isSuppressed(input.workspaceId, draft.candidateId, draft.companyId, rev.toEmail);
    if (suppressed) throw new AppError(422, 'SUPPRESSED', `Bu alıcıya/firmaya gönderim engelli: ${suppressed.reason}`);

    const docs = rev.documentIds.length ? await this.prisma.documentVersion.findMany({ where: { id: { in: rev.documentIds } } }) : [];
    if (docs.length !== rev.documentIds.length || docs.some((d) => d.candidateId !== draft.candidateId))
      throw new AppError(422, 'DOCUMENT_NOT_OWNED', 'Belgeler bu adaya ait değil');
    if (docs.some((d) => d.scanState !== 'clean' || d.archived)) throw new AppError(422, 'DOCUMENT_NOT_READY', 'Belge taraması tamamlanmadı veya belge arşivlendi');
    if (estimateRawSize(rev.body.length, docs.map((d) => d.size)) > MAX_RAW_BYTES)
      throw new AppError(422, 'ATTACHMENT_TOO_LARGE', 'Ekler sağlayıcı sınırını aşıyor; büyük portföy için bağlantı kullanın');

    let jobKey: string | null = null;
    if (draft.jobId) {
      const job = await this.prisma.job.findUniqueOrThrow({ where: { id: draft.jobId } });
      jobKey = job.canonicalKey;
      if (draft.intentType === 'job_application') {
        if (job.status === 'closed') throw new AppError(422, 'JOB_CLOSED', 'Kapalı ilana ilan başvurusu gönderilmez; niyet başvurusu oluşturun');
        if (input.sendMode !== 'manual' && job.status !== 'open') throw new AppError(422, 'JOB_NOT_OPEN', 'İlan açık olarak doğrulanmadı; toplu/otomatik gönderim yapılmaz');
        if (job.channel === 'platform') throw new AppError(422, 'CHANNEL_MANUAL_ONLY', 'Bu kaynak yalnızca platformda başvuruyu destekliyor — "Platformda tamamla"');
      }
    }
    const target = draft.intentType === 'job_application' && jobKey ? `job:${jobKey}` : draft.intentType === 'follow_up' ? `followup:${draft.followUpOfId}` : `company:${draft.companyId}:${istanbulDay().slice(0, 7)}`;
    const activeKey = activeKeyFor(draft.candidateId, target, draft.intentType);
    const dup = await this.prisma.applicationAttempt.findUnique({ where: { activeKey } });
    if (dup) throw new AppError(409, 'ALREADY_APPLIED', 'Bu aday bu ilana/amaca zaten başvurdu veya gönderim kuyrukta', { attemptId: dup.id, state: dup.state });
    if (draft.intentType !== 'follow_up' && !(input.overrideCooldown && COOLDOWN_OVERRIDE_MODES.includes(input.sendMode))) {
      if (await this.companyCooldownActive(draft.candidateId, draft.companyId, 30))
        throw new AppError(409, 'COMPANY_COOLDOWN', 'Bu firmaya son 30 gün içinde temas edildi');
    }
    if (input.sendMode === 'manual') {
      const used = await this.usage.get(input.workspaceId, `send:${account.id}`);
      if (used >= account.dailyLimit) throw new AppError(429, 'DAILY_LIMIT', `Bu hesap için günlük gönderim limiti (${account.dailyLimit}) doldu`);
    }

    const documentHashes = docs.map((d) => ({ id: d.id, sha256: d.sha256 }));
    const scheduledAt = input.scheduledAt ?? null;
    try {
      const attempt = await this.prisma.$transaction(async (tx) => {
        const a = await tx.applicationAttempt.create({
          data: {
            workspaceId: input.workspaceId,
            candidateId: draft.candidateId,
            draftId: draft.id,
            draftRevision: rev.revision,
            draftHash: rev.hash,
            policyVersionId: input.policyVersionId ?? null,
            campaignId: input.campaignId ?? draft.campaignId ?? null,
            companyId: draft.companyId,
            jobId: draft.jobId,
            jobCanonicalKey: jobKey,
            intentType: draft.intentType,
            sendMode: input.sendMode,
            mailAccountId: account.id,
            toEmail: rev.toEmail!.toLowerCase(),
            idempotencyKey: input.idempotencyKey,
            requestHash,
            activeKey,
            state: 'queued',
            documentHashes,
            scheduledAt,
            createdById: input.userId,
          },
        });
        const upd = await tx.applicationDraft.updateMany({ where: { id: draft.id, currentRevision: rev.revision }, data: { status: 'queued', mailAccountId: account.id } });
        if (upd.count !== 1) throw new AppError(409, 'DOCUMENT_CHANGED', 'Taslak gönderim sırasında değişti');
        await this.outbox.emit(
          { workspaceId: input.workspaceId, eventType: 'send.attempt', aggregateId: a.id, dedupKey: `send:${a.id}:0`, payload: { attemptId: a.id }, availableAt: scheduledAt ?? new Date() },
          tx,
        );
        await this.audit.log(
          { workspaceId: input.workspaceId, actorId: input.userId, actorType: input.userId ? 'user' : 'worker', action: 'application.queue', entityType: 'ApplicationAttempt', entityId: a.id, next: { draftRevision: rev.revision, sendMode: input.sendMode, to: a.toEmail } },
          tx,
        );
        return a;
      });
      return { attempt, reused: false };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const target = String((e.meta as any)?.target ?? '');
        if (target.includes('idempotency')) {
          const again = await this.prisma.applicationAttempt.findUnique({ where: { workspaceId_idempotencyKey: { workspaceId: input.workspaceId, idempotencyKey: input.idempotencyKey } } });
          if (again && again.requestHash === requestHash) return { attempt: again, reused: true };
          throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'Aynı Idempotency-Key farklı içerikle kullanıldı');
        }
        throw new AppError(409, 'ALREADY_APPLIED', 'Bu aday bu ilana/amaca zaten başvurdu veya gönderim kuyrukta');
      }
      throw e;
    }
  }

  private async finish(attemptId: string, state: string, data: Prisma.ApplicationAttemptUpdateInput, tx?: Tx) {
    const db = tx ?? this.prisma;
    const holds = holdsActiveKey(state as any);
    const updated = await db.applicationAttempt.update({ where: { id: attemptId }, data: { ...data, state, ...(holds ? {} : { activeKey: null }) } });
    if (NOT_SENT_STATES.includes(state)) await this.reopenReturns([attemptId], db);
    return updated;
  }

  /**
   * Gönderilemeyen yeniden gönderim, yerine geçtiği mail dönüşünü yeniden açar; otopilotun bu dönüş için uyguladığı
   * karar da onay bekleyen öneriye döner. Böylece dönüş "tekrar gönderildi" görünüp sahipsiz kalmaz.
   */
  private async reopenReturns(attemptIds: string[], db: Tx | PrismaService = this.prisma) {
    if (!attemptIds.length) return;
    await db.inboundMessage.updateMany({ where: { resentAttemptId: { in: attemptIds }, status: 'resent' }, data: { status: 'open', resentAttemptId: null, handledAt: null } });
    await db.autopilotAction.updateMany({ where: { resultAttemptId: { in: attemptIds }, state: 'executed' }, data: { state: 'proposed', resultAttemptId: null, executedAt: null } });
  }

  /**
   * Kuyruktaki gönderimleri iptal eder ve bağlı taslakları incelemeye döndürür (kilitli "queued" taslak kalmaz).
   */
  async cancelQueued(where: Prisma.ApplicationAttemptWhereInput, reason: string, tx?: Tx) {
    const db = tx ?? this.prisma;
    const rows = await db.applicationAttempt.findMany({ where: { ...where, state: 'queued' }, select: { id: true, draftId: true } });
    if (rows.length === 0) return 0;
    await db.applicationAttempt.updateMany({ where: { id: { in: rows.map((r) => r.id) }, state: 'queued' }, data: { state: 'cancelled', stateReason: reason, activeKey: null } });
    await db.applicationDraft.updateMany({ where: { id: { in: rows.map((r) => r.draftId) }, status: 'queued' }, data: { status: 'needs_review', blockedReasons: { push: reason } } });
    await this.reopenReturns(rows.map((r) => r.id), db);
    return rows.length;
  }

  async cancel(workspaceId: string, attemptId: string, reason: string, actorId: string | null) {
    const res = await this.prisma.applicationAttempt.updateMany({
      where: { id: attemptId, workspaceId, state: 'queued' },
      data: { state: 'cancelled', stateReason: reason, activeKey: null },
    });
    if (res.count === 1) {
      const a = await this.prisma.applicationAttempt.findUniqueOrThrow({ where: { id: attemptId } });
      await this.prisma.applicationDraft.update({ where: { id: a.draftId }, data: { status: 'cancelled' } });
      await this.reopenReturns([attemptId]);
      await this.audit.log({ workspaceId, actorId, action: 'application.cancel', entityType: 'ApplicationAttempt', entityId: attemptId, reason });
    }
    return res.count === 1;
  }

  /**
   * Aynı hesaptan art arda gönderim arasında rastgele aralık bırakır. Slot atomik olarak ayrılır; ayrılamazsa
   * bir sonraki uygun zaman döner.
   */
  private async reservePacingSlot(accountId: string): Promise<Date | null> {
    const key = `${PACING_KEY_PREFIX}${accountId}`;
    const gapSeconds = (SEND_GAP_MIN_MS + Math.floor(Math.random() * (SEND_GAP_MAX_MS - SEND_GAP_MIN_MS))) / 1000;
    const reserved = await this.prisma.$queryRaw<{ key: string }[]>`
      INSERT INTO "KeyValue" (key, value, "updatedAt")
      VALUES (${key}, jsonb_build_object('next', to_char((now() + make_interval(secs => ${gapSeconds}::float8)) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')), now())
      ON CONFLICT (key) DO UPDATE
        SET value = "KeyValue".value || jsonb_build_object('next', to_char((now() + make_interval(secs => ${gapSeconds}::float8)) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')), "updatedAt" = now()
        WHERE ("KeyValue".value->>'next')::timestamptz <= now()
      RETURNING key`;
    if (reserved.length) return null;
    const queued = await this.prisma.$queryRaw<{ tail: string }[]>`
      UPDATE "KeyValue"
        SET value = value || jsonb_build_object('tail', to_char((GREATEST(
              COALESCE((value->>'tail')::timestamptz + make_interval(secs => ${gapSeconds}::float8), (value->>'next')::timestamptz),
              (value->>'next')::timestamptz,
              now())) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
            "updatedAt" = now()
        WHERE key = ${key}
      RETURNING value->>'tail' AS tail`;
    return new Date(new Date(queued[0]?.tail ?? Date.now()).getTime() + PACING_JITTER_MS);
  }

  /** Hesabın kuyruğu: toplam, kalan ve tahmini bitiş (aralık ortalaması ve günlük limit hesaba katılır). */
  async queueSummary(workspaceId: string) {
    const queued = await this.prisma.applicationAttempt.findMany({ where: { workspaceId, state: { in: ['queued', 'sending'] } }, select: { queuedAt: true, mailAccountId: true, scheduledAt: true } });
    if (!queued.length) return null;
    const since = new Date(Math.min(...queued.map((q) => q.queuedAt.getTime())));
    const total = await this.prisma.applicationAttempt.count({ where: { workspaceId, queuedAt: { gte: since }, state: { not: 'cancelled' } } });
    const accountId = queued.find((q) => q.mailAccountId)?.mailAccountId ?? null;
    const account = accountId ? await this.prisma.mailAccount.findUnique({ where: { id: accountId }, select: { id: true, dailyLimit: true } }) : null;
    const usedToday = account ? await this.usage.get(workspaceId, `send:${account.id}`) : 0;
    const remainingToday = account ? Math.max(0, account.dailyLimit - usedToday) : queued.length;
    const sendableToday = Math.min(queued.length, remainingToday);
    const averageGapMs = (SEND_GAP_MIN_MS + SEND_GAP_MAX_MS) / 2;
    return {
      total,
      sent: total - queued.length,
      remaining: queued.length,
      deferredToTomorrow: queued.length - sendableToday,
      estimatedFinishAt: new Date(Date.now() + sendableToday * averageGapMs).toISOString(),
      dailyLimit: account?.dailyLimit ?? null,
      usedToday,
    };
  }

  /** Sıradaki (ertelenmiş) başvuruyu hemen yeniden işlemeye alır; limit hâlâ doluysa yeniden ertelenir. */
  async retryQueued(workspaceId: string, attemptIds?: string[]) {
    const attempts = await this.prisma.applicationAttempt.findMany({ where: { workspaceId, state: 'queued', ...(attemptIds ? { id: { in: attemptIds } } : {}) }, select: { id: true } });
    const stamp = Date.now();
    for (const a of attempts) {
      await this.prisma.applicationAttempt.update({ where: { id: a.id }, data: { scheduledAt: null, stateReason: null } });
      await this.outbox.emit({ workspaceId, eventType: 'send.attempt', aggregateId: a.id, dedupKey: `send:${a.id}:retry:${stamp}`, payload: { attemptId: a.id } });
    }
    return { requeued: attempts.length };
  }

  /**
   * Worker gönderim işlemi — doküman §13:
   * 1) Satır kilidi + durum/politika/hesap/sürüm/bastırma/tekrar/ilan kontrolleri; limit rezervasyonu; state=sending.
   * 2) Acil durdur sağlayıcı çağrısından hemen önce yeniden okunur.
   * 3) Tek dış çağrı. Kabul → provider_accepted. Belirsizlik → submission_unknown (otomatik tekrar yok).
   */
  async processAttempt(attemptId: string): Promise<string> {
    const pre = await this.prisma.applicationAttempt.findUnique({ where: { id: attemptId } });
    if (!pre || pre.state !== 'queued') return 'skipped';
    if (pre.scheduledAt && pre.scheduledAt.getTime() > Date.now() + 1000) {
      await this.outbox.emit({ workspaceId: pre.workspaceId, eventType: 'send.attempt', aggregateId: pre.id, dedupKey: `send:${pre.id}:${pre.scheduledAt.getTime()}`, payload: { attemptId: pre.id }, availableAt: pre.scheduledAt });
      return 'not_yet';
    }
    if (pre.mailAccountId && env().SEND_PACING_ENABLED) {
      const wait = await this.reservePacingSlot(pre.mailAccountId);
      if (wait) {
        await this.prisma.applicationAttempt.update({ where: { id: pre.id }, data: { scheduledAt: wait, stateReason: 'PACING' } });
        await this.outbox.emit({ workspaceId: pre.workspaceId, eventType: 'send.attempt', aggregateId: pre.id, dedupKey: `send:${pre.id}:${wait.getTime()}`, payload: { attemptId: pre.id }, availableAt: wait });
        return 'paced';
      }
    }

    // Otomatik ilan başvurusunda tazelik: kaynakta yeniden kontrol (en fazla 10 dakika eski).
    if (pre.sendMode === 'auto' && pre.intentType === 'job_application' && pre.jobId) {
      const job = await this.prisma.job.findUnique({ where: { id: pre.jobId }, include: { listings: true } });
      if (job && (!job.lastVerifiedAt || Date.now() - job.lastVerifiedAt.getTime() > 10 * 60_000)) {
        for (const sid of new Set(job.listings.map((l) => l.sourceId))) await this.ingest.runSource(sid, 'verify');
      }
    }

    const outcome = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "ApplicationAttempt" WHERE id = ${attemptId} FOR UPDATE`;
      const a = await tx.applicationAttempt.findUniqueOrThrow({ where: { id: attemptId } });
      if (a.state !== 'queued') return { kind: 'skip' as const };
      const block = async (reason: string, state: 'cancelled' | 'blocked' = 'blocked') => {
        await this.finish(a.id, state, { stateReason: reason }, tx);
        await tx.applicationDraft.update({ where: { id: a.draftId }, data: { status: 'needs_review', blockedReasons: { push: reason } } });
        await this.outbox.emit({ workspaceId: a.workspaceId, eventType: 'notify', aggregateId: a.id, dedupKey: `blocked:${a.id}`, payload: { type: 'send_blocked', title: 'Gönderim durduruldu', body: `Gerekçe: ${reason}`, link: `/applications?attempt=${a.id}` } }, tx);
        return { kind: 'blocked' as const, reason };
      };
      const ws = await tx.workspace.findUniqueOrThrow({ where: { id: a.workspaceId } });
      if (ws.automationPaused && a.sendMode !== 'manual') return block('EMERGENCY_STOP', 'cancelled');
      if (a.campaignId) {
        const c = await tx.campaign.findUnique({ where: { id: a.campaignId } });
        if (c?.state === 'paused') {
          // Duraklatılmış kampanya: iş kuyrukta kalır, devam edilince yeniden planlanır.
          return { kind: 'deferred' as const, until: null, reason: 'CAMPAIGN_PAUSED' };
        }
        if (c?.state === 'cancelled') return block('CAMPAIGN_CANCELLED', 'cancelled');
      }
      if (a.policyVersionId) {
        const pv = await tx.automationPolicyVersion.findUnique({ where: { id: a.policyVersionId }, include: { policy: true } });
        if (!pv || !pv.policy.active || pv.policy.version !== pv.version) return block('POLICY_CHANGED', 'cancelled');
      }
      if (a.sendMode === 'autopilot' && !(await tx.automationPolicy.count({ where: { workspaceId: a.workspaceId, candidateId: a.candidateId, active: true, autoSend: true } }))) return block('AUTOPILOT_OFF', 'cancelled');
      const draft = await tx.applicationDraft.findUniqueOrThrow({ where: { id: a.draftId } });
      const rev = await tx.draftRevision.findUnique({ where: { draftId_revision: { draftId: draft.id, revision: draft.currentRevision } } });
      if (!rev || rev.hash !== a.draftHash || draft.currentRevision !== a.draftRevision) return block('DOCUMENT_CHANGED');
      const docs = rev.documentIds.length ? await tx.documentVersion.findMany({ where: { id: { in: rev.documentIds } } }) : [];
      const expected = a.documentHashes as { id: string; sha256: string }[];
      if (docs.length !== expected.length || expected.some((e) => !docs.find((d) => d.id === e.id && d.sha256 === e.sha256 && d.scanState === 'clean' && !d.archived)))
        return block('DOCUMENT_CHANGED');
      const account = a.mailAccountId ? await tx.mailAccount.findUnique({ where: { id: a.mailAccountId } }) : null;
      if (!account || account.health !== 'ok' || account.candidateId !== a.candidateId) return block('ACCOUNT_UNHEALTHY');
      if (await this.isSuppressed(a.workspaceId, a.candidateId, a.companyId, a.toEmail, tx)) return block('SUPPRESSED', 'cancelled');
      if (await this.addressBook.isDead(a.toEmail)) return block('DEAD_ADDRESS', 'cancelled');
      if (a.toEmail && (await tx.contactPoint.findFirst({ where: { companyId: a.companyId, email: a.toEmail, suppressed: true } }))) return block('SUPPRESSED', 'cancelled');
      if (a.jobId && a.intentType === 'job_application') {
        const job = await tx.job.findUniqueOrThrow({ where: { id: a.jobId }, include: { listings: { include: { source: true } } } });
        if (job.status === 'closed' || (a.sendMode !== 'manual' && job.status !== 'open')) return block('JOB_NOT_OPEN', 'cancelled');
        if (a.sendMode === 'auto') {
          if (!job.lastVerifiedAt || Date.now() - job.lastVerifiedAt.getTime() > 10 * 60_000) return block('FRESHNESS_STALE');
          if (job.listings.some((l) => ['blocked', 'degraded'].includes(l.source.health))) return block('SOURCE_BLOCKED');
        }
      }
      const recipientContact = a.toEmail ? await tx.contactPoint.findFirst({ where: { companyId: a.companyId, email: a.toEmail.toLowerCase() } }) : null;
      if (recipientContact && NON_RECIPIENT_KINDS.includes(recipientContact.kind)) return block('RECIPIENT_NOT_HR');
      // Limit rezervasyonu: hesap günlük limiti + (otomatikte) politika limiti.
      if (!(await this.usage.reserve(a.workspaceId, `send:${account.id}`, account.dailyLimit, tx))) {
        return { kind: 'deferred' as const, until: nextDaySendSlot(new Date(), '09:00', '18:00', [1, 2, 3, 4, 5]), reason: 'DAILY_LIMIT' };
      }
      if (a.policyVersionId) {
        const pv = await tx.automationPolicyVersion.findUniqueOrThrow({ where: { id: a.policyVersionId }, include: { policy: true } });
        const key = a.intentType === 'job_application' ? `auto:${pv.policyId}:job` : `auto:${pv.policyId}:intent`;
        const limit = a.intentType === 'job_application' ? pv.policy.dailyLimit : pv.policy.intentDailyLimit;
        if (!(await this.usage.reserve(a.workspaceId, key, limit, tx))) {
          await this.usage.release(a.workspaceId, `send:${account.id}`, tx);
          return { kind: 'deferred' as const, until: nextDaySendSlot(new Date(), pv.policy.sendWindowStart, pv.policy.sendWindowEnd, pv.policy.sendDays), reason: 'POLICY_DAILY_LIMIT' };
        }
      }
      const payloadHash = hashObject({ to: a.toEmail, subject: rev.subject, body: rev.body, docs: expected, account: account.id });
      await tx.applicationAttempt.update({ where: { id: a.id }, data: { state: 'sending', sendingAt: new Date(), sentPayloadHash: payloadHash } });
      return { kind: 'send' as const, attempt: a, rev, account, docs };
    });

    if (outcome.kind === 'skip') return 'skipped';
    if (outcome.kind === 'blocked') return `blocked:${outcome.reason}`;
    if (outcome.kind === 'deferred') {
      if (outcome.until) {
        await this.prisma.applicationAttempt.update({ where: { id: attemptId }, data: { scheduledAt: outcome.until, stateReason: outcome.reason } });
        await this.outbox.emit({ workspaceId: pre.workspaceId, eventType: 'send.attempt', aggregateId: attemptId, dedupKey: `send:${attemptId}:${outcome.until.getTime()}`, payload: { attemptId }, availableAt: outcome.until });
      }
      return 'deferred';
    }

    const { attempt, rev, account, docs } = outcome;
    // Acil durdur: gönderici çağrısından hemen önce yeniden okunur.
    if (attempt.sendMode !== 'manual') {
      const ws = await this.prisma.workspace.findUniqueOrThrow({ where: { id: attempt.workspaceId } });
      if (ws.automationPaused) {
        await this.finish(attempt.id, 'failed_confirmed', { stateReason: 'EMERGENCY_STOP' });
        await this.usage.release(attempt.workspaceId, `send:${account.id}`);
        await this.prisma.applicationDraft.update({ where: { id: attempt.draftId }, data: { status: 'cancelled' } });
        return 'cancelled:EMERGENCY_STOP';
      }
    }
    const candidate = await this.prisma.candidateProfile.findUniqueOrThrow({ where: { id: attempt.candidateId } });
    const attachments = await Promise.all(
      docs.map(async (d) => ({ filename: d.fileName, content: await this.storage.get(d.objectKey), contentType: d.mime })),
    );
    const text = rev.links.length && !rev.links.every((l) => rev.body.includes(l)) ? `${rev.body}\n\n${rev.links.filter((l) => !rev.body.includes(l)).join('\n')}` : rev.body;
    try {
      const res = await mailProviderFor(account.provider).send(account, {
        from: account.accountEmail,
        fromName: account.displayName ?? candidate.displayName,
        to: attempt.toEmail!,
        subject: rev.subject,
        text,
        attachments,
        headers: { 'X-Application-ID': attempt.id },
      });
      await this.prisma.$transaction(async (tx) => {
        await this.finish(attempt.id, 'provider_accepted', { providerMessageId: res.providerMessageId, providerThreadId: res.threadId ?? null, acceptedAt: new Date(), stateReason: null }, tx);
        await tx.applicationDraft.update({ where: { id: attempt.draftId }, data: { status: 'sent' } });
        const draft = await tx.applicationDraft.findUniqueOrThrow({ where: { id: attempt.draftId } });
        if (draft.opportunityId) await tx.opportunity.updateMany({ where: { id: draft.opportunityId }, data: { status: 'applied' } });
        if (attempt.intentType !== 'follow_up') {
          await tx.followUp.upsert({
            where: { attemptId: attempt.id },
            create: { workspaceId: attempt.workspaceId, attemptId: attempt.id, dueAt: addBusinessDays(new Date(), 7) },
            update: {},
          });
        }
        const company = (await tx.company.findUnique({ where: { id: attempt.companyId } })) ?? { name: 'firma' };
        await this.outbox.emit(
          {
            workspaceId: attempt.workspaceId,
            eventType: 'notify',
            aggregateId: attempt.id,
            dedupKey: `accepted:${attempt.id}`,
            payload: { type: 'send_accepted', title: `Gönderim sağlayıcı tarafından kabul edildi: ${company.name}`, body: 'Kabul, teslim veya okunma garantisi değildir.', link: `/applications?attempt=${attempt.id}` },
          },
          tx,
        );
        await this.audit.log({ workspaceId: attempt.workspaceId, actorType: 'worker', action: 'application.accepted', entityType: 'ApplicationAttempt', entityId: attempt.id, next: { providerMessageId: res.providerMessageId } }, tx);
      });
      await this.noteSent(attempt.id);
      return 'provider_accepted';
    } catch (e) {
      if (e instanceof MailDefiniteError) {
        await this.finish(attempt.id, 'failed_confirmed', { stateReason: `${e.code}: ${e.message}`.slice(0, 500) });
        await this.usage.release(attempt.workspaceId, `send:${account.id}`);
        await this.prisma.applicationDraft.update({ where: { id: attempt.draftId }, data: { status: 'needs_review', blockedReasons: { push: e.code } } });
        if (e.accountProblem) await this.prisma.mailAccount.update({ where: { id: account.id }, data: { health: 'needs_reauth', healthReason: e.message } });
        await this.outbox.emit({ workspaceId: attempt.workspaceId, eventType: 'notify', aggregateId: attempt.id, dedupKey: `failed:${attempt.id}`, payload: { type: 'send_failed', title: 'Gönderim başarısız', body: e.message, link: `/applications?attempt=${attempt.id}` } });
        return 'failed_confirmed';
      }
      // Belirsiz: kabul edilip edilmediği bilinmiyor. Otomatik yeniden gönderim YAPILMAZ.
      const msg = e instanceof MailUnknownError ? e.message : `Beklenmeyen hata: ${(e as Error).message}`;
      await this.finish(attempt.id, 'submission_unknown', { stateReason: msg.slice(0, 500) });
      await this.outbox.emit({
        workspaceId: attempt.workspaceId,
        eventType: 'notify',
        aggregateId: attempt.id,
        dedupKey: `unknown:${attempt.id}`,
        payload: { type: 'send_unknown', title: 'Gönderim sonucu belirsiz', body: 'Sağlayıcı kabulü doğrulanamadı. Gönderilmiş klasörünüzü kontrol edip sonucu işaretleyin; otomatik tekrar yapılmaz.', link: `/applications?attempt=${attempt.id}` },
      });
      return 'submission_unknown';
    }
  }

  /** Kullanıcı belirsiz gönderimi uzlaştırır: gönderildi (kabul) ya da gönderilmedi (kontrollü yeniden deneme serbest). */
  async resolveUnknown(workspaceId: string, attemptId: string, sent: boolean, actorId: string) {
    const a = await this.prisma.applicationAttempt.findFirst({ where: { id: attemptId, workspaceId } });
    if (!a) throw notFound('Başvuru');
    if (a.state !== 'submission_unknown') throw new AppError(409, 'NOT_UNKNOWN', 'Başvuru belirsiz durumda değil');
    if (sent) {
      await this.finish(a.id, 'provider_accepted', { stateReason: 'Kullanıcı gönderildiğini doğruladı', acceptedAt: new Date() });
      await this.prisma.applicationDraft.update({ where: { id: a.draftId }, data: { status: 'sent' } });
      await this.noteSent(a.id);
    } else {
      await this.finish(a.id, 'failed_confirmed', { stateReason: 'Kullanıcı gönderilmediğini doğruladı' });
      await this.prisma.applicationDraft.update({ where: { id: a.draftId }, data: { status: 'draft' } });
    }
    await this.audit.log({ workspaceId, actorId, action: 'application.reconcile', entityType: 'ApplicationAttempt', entityId: a.id, next: { sent } });
    return this.prisma.applicationAttempt.findUniqueOrThrow({ where: { id: a.id } });
  }

  /** Worker çökmesi sonrası "sending"de kalan kayıtlar belirsiz sayılır; kuyrukta kalan işler yeniden planlanır. */
  async reconcile() {
    const stuck = await this.prisma.applicationAttempt.findMany({ where: { state: 'sending', sendingAt: { lt: new Date(Date.now() - 10 * 60_000) } } });
    for (const a of stuck) {
      await this.finish(a.id, 'submission_unknown', { stateReason: 'Worker gönderim sırasında durdu; sonuç bilinmiyor' });
    }
    const orphaned = await this.prisma.applicationAttempt.findMany({
      where: { state: 'queued', OR: [{ scheduledAt: null }, { scheduledAt: { lt: new Date() } }], queuedAt: { lt: new Date(Date.now() - 5 * 60_000) } },
      take: 200,
    });
    for (const a of orphaned) {
      await this.outbox.emit({ workspaceId: a.workspaceId, eventType: 'send.attempt', aggregateId: a.id, dedupKey: `send:${a.id}:reconcile:${Math.floor(Date.now() / 300_000)}`, payload: { attemptId: a.id } });
    }
    return { stuck: stuck.length, requeued: orphaned.length };
  }
}
