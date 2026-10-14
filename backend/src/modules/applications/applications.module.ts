import { Body, Controller, Delete, Get, Headers, HttpCode, Injectable, Module, Param, Patch, Post, Query } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AuditService } from '../../common/audit.service';
import { Ctx, RequestContext } from '../../common/auth';
import { hashObject, randomToken } from '../../common/crypto';
import { AppError, notFound } from '../../common/errors';
import { OutboxService } from '../../common/outbox.service';
import { cursorArgs, paginate, pageQuery } from '../../common/pagination';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { istanbulDay } from '../../common/time';
import { ZodPipe } from '../../common/zod.pipe';
import { activeKeyFor, STATE_LABELS } from '../../domain/attempt-state';
import { REASON_LABELS } from '../../domain/policy';
import { INTENT_LABELS } from '../../domain/templates';
import { AutomationService, policySnapshot } from '../../engine/automation.service';
import { DraftingService } from '../../engine/drafting.service';
import { RepliesService } from '../../engine/replies.service';
import { SendingService } from '../../engine/sending.service';

const intentEnum = z.enum(['job_application', 'intent_after_closed', 'general_intent', 'project_collab', 'follow_up']);
const createDraftSchema = z.object({
  candidateId: z.string(),
  companyId: z.string(),
  jobId: z.string().optional().nullable(),
  intentType: intentEnum.optional(),
  mailAccountId: z.string().optional().nullable(),
  contactId: z.string().optional().nullable(),
  documentIds: z.array(z.string()).optional(),
  useAi: z.boolean().default(true),
});
const patchDraftSchema = z.object({
  revision: z.number().int(),
  toEmail: z.string().email().nullable().optional(),
  subject: z.string().min(1).max(300).optional(),
  body: z.string().min(1).max(20000).optional(),
  documentIds: z.array(z.string()).optional(),
  links: z.array(z.string().url()).optional(),
  mailAccountId: z.string().nullable().optional(),
});
const sendSchema = z.object({
  expectedRevision: z.number().int(),
  mailAccountId: z.string().optional(),
  overrideCooldown: z.boolean().default(false),
});
const draftsQuery = pageQuery.extend({ status: z.string().optional(), candidateId: z.string().optional(), campaignId: z.string().optional() });
const appsQuery = pageQuery.extend({ state: z.string().optional(), candidateId: z.string().optional(), companyId: z.string().optional() });
const outcomeSchema = z.object({ outcome: z.enum(['interview', 'rejection', 'offer', 'no_response', 'other']), notes: z.string().max(4000).optional() });
const replySchema = z.object({
  subject: z.string().max(300).optional(),
  snippet: z.string().max(4000).optional(),
  fromEmail: z.string().email().optional(),
  classification: z.enum(['human_reply', 'autoresponder', 'bounce', 'rejection', 'interview', 'do_not_contact', 'unknown']).optional(),
});
const campaignSchema = z.object({
  candidateId: z.string(),
  mailAccountId: z.string(),
  name: z.string().min(1).max(160),
  intentType: z.enum(['job_application', 'intent_after_closed', 'general_intent', 'project_collab']).default('general_intent'),
  companyIds: z.array(z.string()).default([]),
  opportunityIds: z.array(z.string()).default([]),
  documentIds: z.array(z.string()).default([]),
  subjectTemplate: z.string().max(300).optional(),
  bodyTemplate: z.string().max(8000).optional(),
  useAi: z.boolean().default(false),
});
const policySchema = z.object({
  candidateId: z.string(),
  searchProfileId: z.string(),
  mailAccountId: z.string(),
  name: z.string().min(1).max(160),
  modeJobApplication: z.boolean().default(false),
  modeGeneralIntent: z.boolean().default(false),
  modeFollowUp: z.boolean().default(false),
  includeAdjacent: z.boolean().default(false),
  fMin: z.number().min(0).max(100).default(85),
  qMin: z.number().min(0).max(100).default(65),
  coverageMin: z.number().min(0).max(1).default(0.6),
  allowedRecipientKinds: z.array(z.enum(['official_hr', 'job_apply', 'general', 'named_recruiter'])).default(['official_hr', 'job_apply']),
  documentIds: z.array(z.string()).default([]),
  dailyLimit: z.number().int().min(1).max(100).default(10),
  intentDailyLimit: z.number().int().min(0).max(50).default(3),
  companyCooldownDays: z.number().int().min(1).max(365).default(30),
  sendWindowStart: z.string().regex(/^\d{2}:\d{2}$/).default('09:00'),
  sendWindowEnd: z.string().regex(/^\d{2}:\d{2}$/).default('18:00'),
  sendDays: z.array(z.number().int().min(1).max(7)).default([1, 2, 3, 4, 5]),
  sendImmediately: z.boolean().default(false),
  autoSend: z.boolean().default(true),
});

@Injectable()
export class ApplicationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly drafting: DraftingService,
    private readonly sending: SendingService,
    private readonly automation: AutomationService,
    private readonly replies: RepliesService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
  ) {}

  // ─────────── Taslaklar ───────────

  async listDrafts(ctx: RequestContext, q: z.infer<typeof draftsQuery>) {
    const where: Prisma.ApplicationDraftWhereInput = { workspaceId: ctx.workspaceId };
    if (q.status) where.status = { in: q.status.split(',') };
    if (q.candidateId) where.candidateId = q.candidateId;
    if (q.campaignId) where.campaignId = q.campaignId;
    const rows = await this.prisma.applicationDraft.findMany({ where, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }], ...cursorArgs(q) });
    const page = paginate(rows, q.limit);
    const companies = new Map((await this.prisma.company.findMany({ where: { id: { in: page.items.map((d) => d.companyId) } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
    const revs = await this.prisma.draftRevision.findMany({ where: { OR: page.items.map((d) => ({ draftId: d.id, revision: d.currentRevision })) } });
    return {
      ...page,
      items: page.items.map((d) => {
        const r = revs.find((x) => x.draftId === d.id);
        return { ...d, companyName: companies.get(d.companyId), intentLabel: INTENT_LABELS[d.intentType as keyof typeof INTENT_LABELS], subject: r?.subject, toEmail: r?.toEmail, generator: r?.generator };
      }),
    };
  }

  async getDraft(ctx: RequestContext, id: string) {
    const draft = await this.scope.draft(ctx, id);
    const [revisions, company, job, candidate, attempts, aiTasks] = await Promise.all([
      this.prisma.draftRevision.findMany({ where: { draftId: id }, orderBy: { revision: 'desc' } }),
      this.prisma.company.findUniqueOrThrow({ where: { id: draft.companyId }, include: { contacts: true, evidence: { where: { accepted: true }, take: 10, orderBy: { evidenceDate: { sort: 'desc', nulls: 'last' } } }, offices: true } }),
      draft.jobId ? this.prisma.job.findUnique({ where: { id: draft.jobId }, include: { listings: { include: { source: { select: { name: true, kind: true } } } } } }) : null,
      this.prisma.candidateProfile.findUniqueOrThrow({
        where: { id: draft.candidateId },
        include: { mailAccounts: { select: { id: true, provider: true, accountEmail: true, health: true } }, documents: { where: { archived: false }, orderBy: { createdAt: 'desc' } } },
      }),
      this.prisma.applicationAttempt.findMany({ where: { draftId: id }, orderBy: { createdAt: 'desc' } }),
      this.prisma.aiTask.findMany({ where: { entityType: 'ApplicationDraft', entityId: id }, orderBy: { createdAt: 'desc' }, take: 5, select: { id: true, status: true, provider: true, error: true, createdAt: true } }),
    ]);
    return { draft, revisions, current: revisions[0] ?? null, company, job, candidate, attempts, aiTasks, intentLabels: INTENT_LABELS };
  }

  async createDraft(ctx: RequestContext, input: z.infer<typeof createDraftSchema>) {
    await this.scope.candidate(ctx, input.candidateId);
    await this.scope.company(ctx, input.companyId);
    const d = await this.drafting.create({ ...input, workspaceId: ctx.workspaceId, origin: 'manual', createdById: ctx.userId });
    await this.audit.log({ workspaceId: ctx.workspaceId, actorId: ctx.userId, action: 'draft.create', entityType: 'ApplicationDraft', entityId: d.id });
    return d;
  }

  async patchDraft(ctx: RequestContext, id: string, input: z.infer<typeof patchDraftSchema>) {
    const draft = await this.scope.draft(ctx, id);
    if (!['draft', 'needs_review'].includes(draft.status)) throw new AppError(409, 'DRAFT_LOCKED', 'Kuyruktaki veya gönderilmiş taslak düzenlenemez; önce gönderimi iptal edin');
    const cur = await this.drafting.currentRevision(id);
    if (input.mailAccountId !== undefined) {
      if (input.mailAccountId) {
        const acc = await this.prisma.mailAccount.findFirst({ where: { id: input.mailAccountId, candidateId: draft.candidateId } });
        if (!acc) throw new AppError(403, 'ACCOUNT_NOT_OWNED', 'Başka adayın mail hesabı kullanılamaz');
      }
      await this.prisma.applicationDraft.update({ where: { id }, data: { mailAccountId: input.mailAccountId } });
    }
    const hasContent = ['toEmail', 'subject', 'body', 'documentIds', 'links'].some((k) => (input as any)[k] !== undefined);
    if (hasContent) {
      const fresh = await this.prisma.applicationDraft.findUniqueOrThrow({ where: { id } });
      await this.drafting.addRevision(
        fresh,
        {
          toEmail: input.toEmail !== undefined ? input.toEmail?.toLowerCase() ?? null : cur?.toEmail ?? null,
          subject: input.subject ?? cur?.subject ?? '',
          body: input.body ?? cur?.body ?? '',
          documentIds: input.documentIds ?? cur?.documentIds ?? [],
          links: input.links ?? cur?.links ?? [],
        },
        { createdById: ctx.userId, generator: 'user', expectedRevision: input.revision, sourceRefs: cur?.sourceRefs },
      );
    }
    return this.getDraft(ctx, id);
  }

  async regenerate(ctx: RequestContext, id: string) {
    const draft = await this.scope.draft(ctx, id);
    if (!['draft', 'needs_review'].includes(draft.status)) throw new AppError(409, 'DRAFT_LOCKED', 'Taslak düzenlenemez');
    const cur = await this.drafting.currentRevision(id);
    const fresh = await this.drafting.create({
      workspaceId: ctx.workspaceId,
      candidateId: draft.candidateId,
      companyId: draft.companyId,
      jobId: draft.jobId,
      intentType: draft.intentType as any,
      mailAccountId: draft.mailAccountId,
      contactId: draft.contactId,
      documentIds: cur?.documentIds,
      origin: draft.origin as any,
      createdById: ctx.userId,
    });
    // Yeni üretilen içeriği mevcut taslağa yeni sürüm olarak taşı, geçici taslağı sil.
    const genRev = await this.drafting.currentRevision(fresh.id);
    if (genRev) {
      await this.drafting.addRevision(draft, { toEmail: cur?.toEmail ?? genRev.toEmail, subject: genRev.subject, body: genRev.body, documentIds: genRev.documentIds, links: genRev.links }, { createdById: ctx.userId, generator: genRev.generator, aiTaskId: genRev.aiTaskId, sourceRefs: genRev.sourceRefs });
      if (fresh.aiStatus === 'awaiting_user' && fresh.aiTaskId) {
        const task = await this.prisma.aiTask.findUnique({ where: { id: fresh.aiTaskId } });
        await this.prisma.aiTask.update({ where: { id: fresh.aiTaskId }, data: { context: { ...((task?.context ?? {}) as object), draftId: id }, entityId: id } });
      }
    }
    await this.prisma.applicationDraft.delete({ where: { id: fresh.id } });
    return this.getDraft(ctx, id);
  }

  async send(ctx: RequestContext, id: string, idempotencyKey: string | undefined, input: z.infer<typeof sendSchema>) {
    await this.scope.draft(ctx, id);
    const { attempt, reused } = await this.sending.queueSend({
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      draftId: id,
      idempotencyKey: idempotencyKey ?? '',
      expectedRevision: input.expectedRevision,
      mailAccountId: input.mailAccountId,
      sendMode: 'manual',
      overrideCooldown: input.overrideCooldown,
    });
    return { applicationId: attempt.id, state: attempt.state, reused };
  }

  async discardDraft(ctx: RequestContext, id: string) {
    const draft = await this.scope.draft(ctx, id);
    if (!['draft', 'needs_review', 'blocked'].includes(draft.status)) throw new AppError(409, 'DRAFT_LOCKED', 'Kuyruktaki/gönderilmiş taslak silinemez');
    await this.prisma.applicationDraft.update({ where: { id }, data: { status: 'cancelled' } });
    return { ok: true };
  }

  /** Kaynak yalnızca platform başvurusunu destekliyorsa kullanıcı platformda tamamlar ve burada işaretler (tekrar engeli). */
  async platformComplete(ctx: RequestContext, id: string) {
    const draft = await this.scope.draft(ctx, id);
    const job = draft.jobId ? await this.prisma.job.findUnique({ where: { id: draft.jobId } }) : null;
    const target = job ? `job:${job.canonicalKey}` : `company:${draft.companyId}:${istanbulDay().slice(0, 7)}`;
    const cur = await this.drafting.currentRevision(id);
    const activeKey = activeKeyFor(draft.candidateId, target, draft.intentType);
    if (await this.prisma.applicationAttempt.findUnique({ where: { activeKey } })) throw new AppError(409, 'ALREADY_APPLIED', 'Bu ilan için başvuru zaten kayıtlı');
    const attempt = await this.prisma.applicationAttempt.create({
      data: {
        workspaceId: ctx.workspaceId,
        candidateId: draft.candidateId,
        draftId: draft.id,
        draftRevision: draft.currentRevision,
        draftHash: cur?.hash ?? hashObject({ id }),
        companyId: draft.companyId,
        jobId: draft.jobId,
        jobCanonicalKey: job?.canonicalKey,
        intentType: draft.intentType,
        channel: 'platform',
        sendMode: 'manual',
        idempotencyKey: `platform:${draft.id}:${randomToken(6)}`,
        requestHash: hashObject({ platform: draft.id }),
        activeKey,
        state: 'outcome_recorded',
        stateReason: 'Kullanıcı platformda tamamladı',
        outcome: 'other',
        createdById: ctx.userId,
      },
    });
    await this.prisma.applicationDraft.update({ where: { id }, data: { status: 'sent' } });
    if (draft.opportunityId) await this.prisma.opportunity.update({ where: { id: draft.opportunityId }, data: { status: 'applied' } });
    await this.audit.log({ workspaceId: ctx.workspaceId, actorId: ctx.userId, action: 'application.platform_complete', entityType: 'ApplicationAttempt', entityId: attempt.id });
    return attempt;
  }

  // ─────────── Başvurular ───────────

  async listApplications(ctx: RequestContext, q: z.infer<typeof appsQuery>) {
    const where: Prisma.ApplicationAttemptWhereInput = { workspaceId: ctx.workspaceId };
    if (q.state) where.state = { in: q.state.split(',') };
    if (q.candidateId) where.candidateId = q.candidateId;
    if (q.companyId) where.companyId = q.companyId;
    const rows = await this.prisma.applicationAttempt.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], ...cursorArgs(q) });
    const page = paginate(rows, q.limit);
    const companies = new Map((await this.prisma.company.findMany({ where: { id: { in: page.items.map((a) => a.companyId) } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
    const revs = await this.prisma.draftRevision.findMany({ where: { OR: page.items.map((a) => ({ draftId: a.draftId, revision: a.draftRevision })) }, select: { draftId: true, revision: true, subject: true } });
    const replies = await this.prisma.inboundMessage.groupBy({ by: ['attemptId'], where: { attemptId: { in: page.items.map((a) => a.id) } }, _count: true });
    return {
      ...page,
      stateLabels: STATE_LABELS,
      items: page.items.map((a) => ({
        ...a,
        companyName: companies.get(a.companyId),
        subject: revs.find((r) => r.draftId === a.draftId && r.revision === a.draftRevision)?.subject,
        replyCount: replies.find((r) => r.attemptId === a.id)?._count ?? 0,
        intentLabel: INTENT_LABELS[a.intentType as keyof typeof INTENT_LABELS],
      })),
    };
  }

  async getApplication(ctx: RequestContext, id: string) {
    const a = await this.scope.attempt(ctx, id);
    const [revision, company, replies, followUp, job, account] = await Promise.all([
      this.prisma.draftRevision.findUnique({ where: { draftId_revision: { draftId: a.draftId, revision: a.draftRevision } } }),
      this.prisma.company.findUniqueOrThrow({ where: { id: a.companyId }, select: { id: true, name: true } }),
      this.prisma.inboundMessage.findMany({ where: { attemptId: a.id }, orderBy: { receivedAt: 'desc' } }),
      this.prisma.followUp.findUnique({ where: { attemptId: a.id } }),
      a.jobId ? this.prisma.job.findUnique({ where: { id: a.jobId }, select: { id: true, title: true, status: true } }) : null,
      a.mailAccountId ? this.prisma.mailAccount.findUnique({ where: { id: a.mailAccountId }, select: { id: true, provider: true, accountEmail: true } }) : null,
    ]);
    return { attempt: a, stateLabel: STATE_LABELS[a.state as keyof typeof STATE_LABELS], revision, company, replies, followUp, job, account };
  }

  async cancelApplication(ctx: RequestContext, id: string) {
    await this.scope.attempt(ctx, id);
    const ok = await this.sending.cancel(ctx.workspaceId, id, 'Kullanıcı iptal etti', ctx.userId);
    if (!ok) throw new AppError(409, 'NOT_CANCELLABLE', 'Yalnızca kuyruktaki gönderim iptal edilebilir');
    return { ok };
  }

  resolveUnknown(ctx: RequestContext, id: string, sent: boolean) {
    return this.sending.resolveUnknown(ctx.workspaceId, id, sent, ctx.userId);
  }

  outcome(ctx: RequestContext, id: string, input: z.infer<typeof outcomeSchema>) {
    return this.replies.recordOutcome(ctx.workspaceId, id, input.outcome, input.notes, ctx.userId);
  }

  addReply(ctx: RequestContext, id: string, input: z.infer<typeof replySchema>) {
    return this.replies.record({ workspaceId: ctx.workspaceId, attemptId: id, ...input, source: 'manual', actorId: ctx.userId });
  }

  // ─────────── Kampanyalar (toplu gönderim) ───────────

  async createCampaign(ctx: RequestContext, input: z.infer<typeof campaignSchema>) {
    await this.scope.candidate(ctx, input.candidateId);
    const acc = await this.prisma.mailAccount.findFirst({ where: { id: input.mailAccountId, candidateId: input.candidateId } });
    if (!acc) throw new AppError(403, 'ACCOUNT_NOT_OWNED', 'Gönderici hesabı bu adaya ait değil');
    const targets: { companyId: string; jobId: string | null; opportunityId: string | null }[] = [];
    for (const cid of input.companyIds) {
      await this.scope.company(ctx, cid);
      targets.push({ companyId: cid, jobId: null, opportunityId: null });
    }
    if (input.opportunityIds.length) {
      const opps = await this.prisma.opportunity.findMany({ where: { id: { in: input.opportunityIds }, workspaceId: ctx.workspaceId } });
      for (const o of opps) if (!targets.find((t) => t.companyId === o.companyId)) targets.push({ companyId: o.companyId, jobId: input.intentType === 'job_application' ? o.jobId : null, opportunityId: o.id });
    }
    if (targets.length === 0) throw new AppError(400, 'NO_TARGETS', 'Kampanya için firma seçin');
    if (input.documentIds.length) await this.assertDocuments(ctx, input.candidateId, input.documentIds);
    if (targets.length > 200) throw new AppError(400, 'TOO_MANY', 'Bir kampanyada en fazla 200 firma olabilir');
    const campaign = await this.prisma.campaign.create({
      data: { workspaceId: ctx.workspaceId, candidateId: input.candidateId, mailAccountId: input.mailAccountId, name: input.name, intentType: input.intentType, documentIds: input.documentIds, subjectTemplate: input.subjectTemplate, bodyTemplate: input.bodyTemplate },
    });
    // Her alıcı için ayrı kişiselleştirilmiş taslak; tek e-postada CC/BCC listesi oluşturulmaz.
    for (const t of targets) {
      await this.drafting.create({
        workspaceId: ctx.workspaceId,
        candidateId: input.candidateId,
        companyId: t.companyId,
        jobId: t.jobId,
        opportunityId: t.opportunityId,
        intentType: input.intentType,
        mailAccountId: input.mailAccountId,
        documentIds: input.documentIds.length ? input.documentIds : undefined,
        origin: 'campaign',
        campaignId: campaign.id,
        createdById: ctx.userId,
        useAi: input.useAi,
        allowManualAi: false,
        subjectTemplate: input.useAi ? null : input.subjectTemplate ?? null,
        bodyTemplate: input.useAi ? null : input.bodyTemplate ?? null,
      });
    }
    await this.audit.log({ workspaceId: ctx.workspaceId, actorId: ctx.userId, action: 'campaign.create', entityType: 'Campaign', entityId: campaign.id, next: { targets: targets.length } });
    return this.getCampaign(ctx, campaign.id);
  }

  listCampaigns(ctx: RequestContext) {
    return this.prisma.campaign.findMany({ where: { workspaceId: ctx.workspaceId }, orderBy: { createdAt: 'desc' } });
  }

  async getCampaign(ctx: RequestContext, id: string) {
    const c = await this.prisma.campaign.findFirst({ where: { id, workspaceId: ctx.workspaceId } });
    if (!c) throw notFound('Kampanya');
    const drafts = await this.listDrafts(ctx, { campaignId: id, limit: 200 } as any);
    const attempts = await this.prisma.applicationAttempt.findMany({ where: { campaignId: id } });
    return {
      campaign: c,
      rows: drafts.items.map((d) => ({ ...d, attempt: attempts.find((a) => a.draftId === d.id) ?? null })),
      stats: Object.fromEntries(Object.entries(attempts.reduce((m: Record<string, number>, a) => ((m[a.state] = (m[a.state] ?? 0) + 1), m), {}))),
    };
  }

  async startCampaign(ctx: RequestContext, id: string) {
    const c = await this.prisma.campaign.findFirst({ where: { id, workspaceId: ctx.workspaceId } });
    if (!c) throw notFound('Kampanya');
    if (!['draft', 'paused'].includes(c.state)) throw new AppError(409, 'CAMPAIGN_STATE', `Kampanya durumu: ${c.state}`);
    await this.prisma.campaign.update({ where: { id }, data: { state: 'running', startedAt: c.startedAt ?? new Date() } });
    const drafts = await this.prisma.applicationDraft.findMany({ where: { campaignId: id, status: { in: ['draft'] } } });
    const results: { draftId: string; ok: boolean; code?: string; message?: string }[] = [];
    let slot = 0;
    for (const d of drafts) {
      try {
        // Satırlar aralıklı planlanır; bir satırın hatası diğerlerini değiştirmez.
        await this.sending.queueSend({
          workspaceId: ctx.workspaceId,
          userId: ctx.userId,
          draftId: d.id,
          idempotencyKey: `campaign:${id}:${d.id}:${d.currentRevision}`,
          expectedRevision: d.currentRevision,
          mailAccountId: c.mailAccountId,
          sendMode: 'campaign',
          campaignId: id,
          scheduledAt: new Date(Date.now() + slot * 90_000),
        });
        slot++;
        results.push({ draftId: d.id, ok: true });
      } catch (e) {
        const err = e as AppError;
        await this.prisma.applicationDraft.update({ where: { id: d.id }, data: { status: 'needs_review', blockedReasons: { push: err.code ?? 'ERROR' } } });
        results.push({ draftId: d.id, ok: false, code: err.code, message: err.message });
      }
    }
    await this.audit.log({ workspaceId: ctx.workspaceId, actorId: ctx.userId, action: 'campaign.start', entityType: 'Campaign', entityId: id, next: { queued: results.filter((r) => r.ok).length, blocked: results.filter((r) => !r.ok).length } });
    return { results };
  }

  async pauseCampaign(ctx: RequestContext, id: string) {
    const c = await this.prisma.campaign.findFirst({ where: { id, workspaceId: ctx.workspaceId } });
    if (!c) throw notFound('Kampanya');
    await this.prisma.campaign.update({ where: { id }, data: { state: 'paused' } });
    return { ok: true };
  }

  async resumeCampaign(ctx: RequestContext, id: string) {
    const c = await this.prisma.campaign.findFirst({ where: { id, workspaceId: ctx.workspaceId } });
    if (!c) throw notFound('Kampanya');
    await this.prisma.campaign.update({ where: { id }, data: { state: 'running' } });
    const queued = await this.prisma.applicationAttempt.findMany({ where: { campaignId: id, state: 'queued' } });
    for (const [i, a] of queued.entries()) {
      const at = new Date(Date.now() + i * 90_000);
      await this.prisma.applicationAttempt.update({ where: { id: a.id }, data: { scheduledAt: at } });
      await this.outbox.emit({ workspaceId: ctx.workspaceId, eventType: 'send.attempt', aggregateId: a.id, dedupKey: `send:${a.id}:resume:${at.getTime()}`, payload: { attemptId: a.id }, availableAt: at });
    }
    return { requeued: queued.length };
  }

  async cancelCampaign(ctx: RequestContext, id: string) {
    const c = await this.prisma.campaign.findFirst({ where: { id, workspaceId: ctx.workspaceId } });
    if (!c) throw notFound('Kampanya');
    await this.prisma.$transaction([
      this.prisma.campaign.update({ where: { id }, data: { state: 'cancelled' } }),
      this.prisma.applicationAttempt.updateMany({ where: { campaignId: id, state: 'queued' }, data: { state: 'cancelled', stateReason: 'CAMPAIGN_CANCELLED', activeKey: null } }),
      this.prisma.applicationDraft.updateMany({ where: { campaignId: id, status: { in: ['draft', 'needs_review', 'queued'] } }, data: { status: 'cancelled' } }),
    ]);
    return { ok: true };
  }

  // ─────────── Otomasyon politikaları ───────────

  listPolicies(ctx: RequestContext) {
    return this.prisma.automationPolicy.findMany({ where: { workspaceId: ctx.workspaceId }, orderBy: { createdAt: 'asc' } });
  }

  async getPolicy(ctx: RequestContext, id: string) {
    await this.scope.policy(ctx, id);
    const policy = await this.prisma.automationPolicy.findUniqueOrThrow({ where: { id }, include: { versions: { orderBy: { version: 'desc' }, take: 30 } } });
    return { policy, reasonLabels: REASON_LABELS };
  }

  async createPolicy(ctx: RequestContext, input: z.infer<typeof policySchema>) {
    await this.scope.candidate(ctx, input.candidateId);
    const sp = await this.scope.searchProfile(ctx, input.searchProfileId);
    if (sp.candidateId !== input.candidateId) throw new AppError(422, 'PROFILE_MISMATCH', 'Arama profili bu adaya ait değil');
    const acc = await this.prisma.mailAccount.findFirst({ where: { id: input.mailAccountId, candidateId: input.candidateId } });
    if (!acc) throw new AppError(403, 'ACCOUNT_NOT_OWNED', 'Gönderici hesabı bu adaya ait değil');
    if (input.documentIds.length) await this.assertDocuments(ctx, input.candidateId, input.documentIds);
    const p = await this.prisma.automationPolicy.create({ data: { ...input, workspaceId: ctx.workspaceId } });
    await this.prisma.automationPolicyVersion.create({ data: { policyId: p.id, version: 1, snapshot: policySnapshot(p) as Prisma.InputJsonValue, reason: 'create', createdById: ctx.userId } });
    await this.audit.log({ workspaceId: ctx.workspaceId, actorId: ctx.userId, action: 'policy.create', entityType: 'AutomationPolicy', entityId: p.id });
    return p;
  }

  async updatePolicy(ctx: RequestContext, id: string, input: Partial<z.infer<typeof policySchema>>) {
    const p = await this.scope.policy(ctx, id);
    if (p.active) throw new AppError(409, 'POLICY_ACTIVE', 'Aktif politika değiştirilemez; önce devre dışı bırakın (yeni sürüm oluşur)');
    if (input.mailAccountId) {
      const acc = await this.prisma.mailAccount.findFirst({ where: { id: input.mailAccountId, candidateId: p.candidateId, workspaceId: ctx.workspaceId } });
      if (!acc) throw new AppError(403, 'ACCOUNT_NOT_OWNED', 'Gönderici hesabı bu adaya ait değil');
    }
    if (input.searchProfileId) {
      const sp = await this.scope.searchProfile(ctx, input.searchProfileId);
      if (sp.candidateId !== p.candidateId) throw new AppError(422, 'PROFILE_MISMATCH', 'Arama profili bu adaya ait değil');
    }
    if (input.documentIds?.length) await this.assertDocuments(ctx, p.candidateId, input.documentIds);
    const { candidateId: _c, ...rest } = input;
    const updated = await this.prisma.automationPolicy.update({ where: { id }, data: { ...rest, version: { increment: 1 } } });
    await this.prisma.automationPolicyVersion.create({ data: { policyId: id, version: updated.version, snapshot: policySnapshot(updated) as Prisma.InputJsonValue, reason: 'update', createdById: ctx.userId } });
    await this.audit.log({ workspaceId: ctx.workspaceId, actorId: ctx.userId, action: 'policy.update', entityType: 'AutomationPolicy', entityId: id, previous: policySnapshot(p), next: policySnapshot(updated) });
    return updated;
  }

  private async assertDocuments(ctx: RequestContext, candidateId: string, ids: string[]) {
    const n = await this.prisma.documentVersion.count({ where: { id: { in: ids }, workspaceId: ctx.workspaceId, candidateId } });
    if (n !== new Set(ids).size) throw new AppError(422, 'DOCUMENT_NOT_OWNED', 'Belgeler bu adaya ait değil');
  }

  async activate(ctx: RequestContext, id: string) {
    await this.scope.policy(ctx, id);
    const p = await this.automation.activate(id, ctx.workspaceId, ctx.userId);
    await this.audit.log({ workspaceId: ctx.workspaceId, actorId: ctx.userId, action: 'policy.activate', entityType: 'AutomationPolicy', entityId: id, next: { version: p.version } });
    return p;
  }

  async deactivate(ctx: RequestContext, id: string) {
    await this.scope.policy(ctx, id);
    const p = await this.automation.deactivate(id, ctx.workspaceId, ctx.userId);
    await this.audit.log({ workspaceId: ctx.workspaceId, actorId: ctx.userId, action: 'policy.deactivate', entityType: 'AutomationPolicy', entityId: id, next: { version: p.version } });
    return p;
  }

  async dryRun(ctx: RequestContext, id: string) {
    await this.scope.policy(ctx, id);
    return this.automation.dryRun(id, ctx.workspaceId);
  }

  async removePolicy(ctx: RequestContext, id: string) {
    const p = await this.scope.policy(ctx, id);
    if (p.active) await this.automation.deactivate(id, ctx.workspaceId, ctx.userId);
    await this.prisma.automationPolicy.delete({ where: { id } });
    return { ok: true };
  }
}

@Controller('v1')
export class ApplicationsController {
  constructor(private readonly svc: ApplicationsService) {}

  @Get('drafts')
  drafts(@Ctx() ctx: RequestContext, @Query(new ZodPipe(draftsQuery)) q: z.infer<typeof draftsQuery>) {
    return this.svc.listDrafts(ctx, q);
  }

  @Get('drafts/:id')
  draft(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.svc.getDraft(ctx, id);
  }

  @Post('drafts')
  createDraft(@Ctx() ctx: RequestContext, @Body(new ZodPipe(createDraftSchema)) body: z.infer<typeof createDraftSchema>) {
    return this.svc.createDraft(ctx, body);
  }

  @Patch('drafts/:id')
  patchDraft(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new ZodPipe(patchDraftSchema)) body: z.infer<typeof patchDraftSchema>) {
    return this.svc.patchDraft(ctx, id, body);
  }

  @Post('drafts/:id/regenerate')
  regenerate(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.svc.regenerate(ctx, id);
  }

  @Post('drafts/:id/send')
  @HttpCode(202)
  send(@Ctx() ctx: RequestContext, @Param('id') id: string, @Headers('idempotency-key') key: string | undefined, @Body(new ZodPipe(sendSchema)) body: z.infer<typeof sendSchema>) {
    return this.svc.send(ctx, id, key, body);
  }

  @Post('drafts/:id/platform-complete')
  platformComplete(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.svc.platformComplete(ctx, id);
  }

  @Delete('drafts/:id')
  discard(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.svc.discardDraft(ctx, id);
  }

  @Get('applications')
  applications(@Ctx() ctx: RequestContext, @Query(new ZodPipe(appsQuery)) q: z.infer<typeof appsQuery>) {
    return this.svc.listApplications(ctx, q);
  }

  @Get('applications/:id')
  application(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.svc.getApplication(ctx, id);
  }

  @Post('applications/:id/cancel')
  cancel(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.svc.cancelApplication(ctx, id);
  }

  @Post('applications/:id/resolve')
  resolve(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new ZodPipe(z.object({ sent: z.boolean() }))) body: { sent: boolean }) {
    return this.svc.resolveUnknown(ctx, id, body.sent);
  }

  @Post('applications/:id/outcome')
  outcome(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new ZodPipe(outcomeSchema)) body: z.infer<typeof outcomeSchema>) {
    return this.svc.outcome(ctx, id, body);
  }

  @Post('applications/:id/replies')
  reply(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new ZodPipe(replySchema)) body: z.infer<typeof replySchema>) {
    return this.svc.addReply(ctx, id, body);
  }

  @Get('campaigns')
  campaigns(@Ctx() ctx: RequestContext) {
    return this.svc.listCampaigns(ctx);
  }

  @Post('campaigns')
  createCampaign(@Ctx() ctx: RequestContext, @Body(new ZodPipe(campaignSchema)) body: z.infer<typeof campaignSchema>) {
    return this.svc.createCampaign(ctx, body);
  }

  @Get('campaigns/:id')
  campaign(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.svc.getCampaign(ctx, id);
  }

  @Post('campaigns/:id/start')
  start(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.svc.startCampaign(ctx, id);
  }

  @Post('campaigns/:id/pause')
  pause(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.svc.pauseCampaign(ctx, id);
  }

  @Post('campaigns/:id/resume')
  resume(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.svc.resumeCampaign(ctx, id);
  }

  @Post('campaigns/:id/cancel')
  cancelCampaign(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.svc.cancelCampaign(ctx, id);
  }

  @Get('policies')
  policies(@Ctx() ctx: RequestContext) {
    return this.svc.listPolicies(ctx);
  }

  @Get('policies/:id')
  policy(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.svc.getPolicy(ctx, id);
  }

  @Post('policies')
  createPolicy(@Ctx() ctx: RequestContext, @Body(new ZodPipe(policySchema)) body: z.infer<typeof policySchema>) {
    return this.svc.createPolicy(ctx, body);
  }

  @Patch('policies/:id')
  updatePolicy(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new ZodPipe(policySchema.partial())) body: Partial<z.infer<typeof policySchema>>) {
    return this.svc.updatePolicy(ctx, id, body);
  }

  @Post('policies/:id/activate')
  activate(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.svc.activate(ctx, id);
  }

  @Post('policies/:id/deactivate')
  deactivate(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.svc.deactivate(ctx, id);
  }

  @Post('policies/:id/dry-run')
  dryRun(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.svc.dryRun(ctx, id);
  }

  @Delete('policies/:id')
  removePolicy(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.svc.removePolicy(ctx, id);
  }
}

@Module({ controllers: [ApplicationsController], providers: [ApplicationsService], exports: [ApplicationsService] })
export class ApplicationsModule {}
