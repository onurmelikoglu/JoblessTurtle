import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../common/audit.service';
import { randomToken } from '../common/crypto';
import { AppError, notFound } from '../common/errors';
import { OutboxService } from '../common/outbox.service';
import { PrismaService } from '../common/prisma.service';
import { LEGACY_CLASSIFICATION_CATEGORY } from '../domain/address-book';
import { canTransition } from '../domain/attempt-state';
import { AddressBookService } from './address-book.service';
import { AiService } from './ai/ai.service';
import { AutomationService } from './automation.service';

export type Classification = 'human_reply' | 'autoresponder' | 'bounce' | 'rejection' | 'interview' | 'do_not_contact' | 'unknown';

@Injectable()
export class RepliesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
    private readonly automation: AutomationService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly addressBook: AddressBookService,
  ) {}

  /**
   * Gelen yanıt kaydı (manuel giriş veya doğrulanmış webhook). Sahte yanıt işlem tetikleyemez:
   * webhook imzası doğrulanmadan bu fonksiyona ulaşılmaz. İnsan yanıtı/ret/bounce/DNC takipleri iptal eder.
   */
  async record(input: {
    workspaceId: string;
    attemptId: string;
    providerMessageId?: string | null;
    subject?: string | null;
    snippet?: string | null;
    fromEmail?: string | null;
    classification?: Classification | null;
    source: 'manual' | 'webhook';
    actorId?: string | null;
  }) {
    const attempt = await this.prisma.applicationAttempt.findFirst({ where: { id: input.attemptId, workspaceId: input.workspaceId } });
    if (!attempt) throw notFound('Başvuru');
    let classification = input.classification ?? null;
    let needsReview = false;
    if (!classification) {
      const r = await this.ai.run({
        workspaceId: input.workspaceId,
        kind: 'reply_classification',
        input: { subject: input.subject, snippet: input.snippet },
        allowManual: false,
        entityType: 'ApplicationAttempt',
        entityId: attempt.id,
      });
      const out = r.status === 'succeeded' ? r.output : { classification: 'unknown', confidence: 0 };
      classification = out.classification;
      needsReview = !!out.needsReview;
      if (needsReview) classification = 'unknown';
    }
    const providerMessageId = input.providerMessageId ?? `manual-${randomToken(8)}`;
    let msg;
    try {
      msg = await this.prisma.inboundMessage.create({
        data: {
          workspaceId: input.workspaceId,
          mailAccountId: attempt.mailAccountId,
          attemptId: attempt.id,
          providerMessageId,
          threadId: attempt.providerThreadId,
          fromEmail: input.fromEmail ?? null,
          subject: input.subject ?? null,
          snippet: input.snippet?.slice(0, 2000) ?? null,
          classification: classification!,
          source: input.source,
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        return { duplicate: true, message: await this.prisma.inboundMessage.findUnique({ where: { workspaceId_providerMessageId: { workspaceId: input.workspaceId, providerMessageId } } }) };
      }
      throw e;
    }

    const stateFor: Record<string, string | null> = {
      human_reply: 'replied',
      interview: 'replied',
      rejection: 'outcome_recorded',
      bounce: 'bounced',
      do_not_contact: 'outcome_recorded',
      autoresponder: null,
      unknown: null,
    };
    const next = stateFor[classification!];
    if (next && canTransition(attempt.state as any, next as any)) {
      await this.prisma.applicationAttempt.update({
        where: { id: attempt.id },
        data: {
          state: next,
          outcome: classification === 'interview' ? 'interview' : classification === 'rejection' ? 'rejection' : attempt.outcome,
        },
      });
    }
    if (['human_reply', 'interview', 'rejection', 'bounce', 'do_not_contact'].includes(classification!)) {
      await this.automation.cancelFollowUps(attempt.id, `Yanıt: ${classification}`);
    }
    if (classification === 'do_not_contact') {
      await this.prisma.suppression.create({ data: { workspaceId: input.workspaceId, companyId: attempt.companyId, reason: 'Firma "iletişime geçmeyin" yanıtı verdi' } });
    }
    if (classification === 'bounce' && attempt.toEmail) {
      await this.prisma.contactPoint.updateMany({ where: { companyId: attempt.companyId, email: attempt.toEmail }, data: { suppressed: true } });
    }
    await this.addressBook.noteOutcome(attempt.id, LEGACY_CLASSIFICATION_CATEGORY[classification!]).catch(() => undefined);
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: attempt.companyId } });
    const type = classification === 'interview' ? 'interview' : classification === 'bounce' ? 'bounce' : classification === 'human_reply' ? 'human_reply' : 'reply_other';
    await this.outbox.emit({
      workspaceId: input.workspaceId,
      eventType: 'notify',
      aggregateId: msg.id,
      dedupKey: `reply:${msg.id}`,
      payload: { type, title: `${company.name}: ${labelFor(classification!)}`, body: needsReview ? 'Sınıflandırma güveni düşük; lütfen inceleyin.' : undefined, link: `/applications?attempt=${attempt.id}` },
    });
    await this.audit.log({ workspaceId: input.workspaceId, actorId: input.actorId ?? null, actorType: input.actorId ? 'user' : 'system', action: 'reply.record', entityType: 'InboundMessage', entityId: msg.id, next: { classification } });
    return { duplicate: false, message: msg };
  }

  async recordOutcome(workspaceId: string, attemptId: string, outcome: string, notes: string | undefined, actorId: string) {
    const a = await this.prisma.applicationAttempt.findFirst({ where: { id: attemptId, workspaceId } });
    if (!a) throw notFound('Başvuru');
    if (!['provider_accepted', 'replied', 'outcome_recorded', 'submission_unknown', 'bounced'].includes(a.state))
      throw new AppError(409, 'INVALID_STATE', 'Bu başvuru için sonuç kaydedilemez');
    const updated = await this.prisma.applicationAttempt.update({ where: { id: a.id }, data: { outcome, notes: notes ?? a.notes, state: a.state === 'provider_accepted' || a.state === 'replied' ? 'outcome_recorded' : a.state } });
    if (['interview', 'rejection', 'offer'].includes(outcome)) await this.automation.cancelFollowUps(a.id, `Sonuç: ${outcome}`);
    await this.audit.log({ workspaceId, actorId, action: 'application.outcome', entityType: 'ApplicationAttempt', entityId: a.id, next: { outcome } });
    return updated;
  }
}

function labelFor(c: string) {
  return (
    {
      human_reply: 'insan yanıtı geldi',
      interview: 'görüşme daveti',
      rejection: 'olumsuz yanıt',
      bounce: 'ileti geri döndü',
      do_not_contact: 'iletişime geçmeyin talebi',
      autoresponder: 'otomatik yanıt',
      unknown: 'yanıt (inceleme gerekli)',
    } as Record<string, string>
  )[c] ?? c;
}
