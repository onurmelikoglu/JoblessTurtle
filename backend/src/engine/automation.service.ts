import { Injectable, Logger } from '@nestjs/common';
import { ApplicationDraft, AutomationPolicy, Prisma } from '@prisma/client';
import { hashObject, randomToken } from '../common/crypto';
import { AppError, errorMessage } from '../common/errors';
import { OutboxService } from '../common/outbox.service';
import { PrismaService } from '../common/prisma.service';
import { nextSendSlot } from '../common/time';
import { UsageService } from '../common/usage.service';
import { activeKeyFor } from '../domain/attempt-state';
import { contactVerifiedForSending, SENDABLE_CONTACT_KINDS } from '../domain/contacts';
import { evaluatePolicy, PolicyDecision, REASON_LABELS, ReasonCode } from '../domain/policy';
import { IntentType } from '../domain/templates';
import { istanbulDay } from '../common/time';
import { DraftingService, intentForCategory, intentForOpportunity, pickContact } from './drafting.service';
import { CandidateFactsService } from './candidate-facts.service';
import { LearnedModelsService } from './learned-models.service';
import { SendingService } from './sending.service';

/** Politika uygun değilse de taslak üretip incelemeye düşen "yumuşak" gerekçeler (doküman §7). */
export const PREDRAFT_CATEGORIES = ['target_open', 'adjacent_open', 'needs_confirmation', 'user_selected', 'sector_target'];
const ACTIVE_DRAFT_STATUSES = ['draft', 'needs_review', 'queued', 'sent'];
const PREDRAFT_SCAN_MULTIPLIER = 4;
const PREDRAFT_BATCH = 6;
const AI_INTERACTIVE_RESERVE_RATIO = 0.25;
const AI_INTERACTIVE_RESERVE_MIN = 10;

/** Arka plan yazıları için bu turda kullanılabilecek AI işi; kullanıcının kendi işlemleri için pay ayrılır. */
export function predraftBudget(dailyLimit: number, usedToday: number) {
  const reserve = Math.max(AI_INTERACTIVE_RESERVE_MIN, Math.ceil(dailyLimit * AI_INTERACTIVE_RESERVE_RATIO));
  return Math.max(0, Math.min(PREDRAFT_BATCH, dailyLimit - usedToday - reserve));
}

const REVIEW_REASONS: ReasonCode[] = ['CONTACT_MISSING', 'CONTACT_UNVERIFIED', 'RECIPIENT_KIND_NOT_ALLOWED', 'CHANNEL_MANUAL_ONLY', 'LOCATION_UNKNOWN', 'MANDATORY_UNKNOWN', 'DOCUMENT_NOT_READY', 'FRESHNESS_STALE'];

export interface DryRunRow {
  opportunityId: string;
  company: string;
  job: string | null;
  intent: IntentType;
  category: string;
  recipient: string | null;
  recipientKind: string | null;
  account: string | null;
  documents: string[];
  f: number | null;
  q: number | null;
  coverage: number | null;
  decision: PolicyDecision;
  reasonLabels: string[];
  wouldSendAt: string | null;
}

export function policySnapshot(p: AutomationPolicy) {
  const { id: _id, createdAt: _c, updatedAt: _u, enabledAt: _e, disabledAt: _d, ...rest } = p;
  return rest;
}

@Injectable()
export class AutomationService {
  private readonly logger = new Logger('Automation');

  constructor(
    private readonly prisma: PrismaService,
    private readonly drafting: DraftingService,
    private readonly sending: SendingService,
    private readonly usage: UsageService,
    private readonly outbox: OutboxService,
    private readonly candidateFacts: CandidateFactsService,
    private readonly models: LearnedModelsService,
  ) {}

  private async refreshCandidateFacts(candidateId: string) {
    try {
      await this.candidateFacts.ensureFromCv(candidateId);
    } catch (e) {
      this.logger.warn(`CV bilgileri güncellenemedi (${candidateId}): ${(e as Error).message}`);
    }
  }

  /** Politika sürümünü sabitler: belge, hesap, kapsam ve eşikler bu sürümde dondurulur. */
  async activate(policyId: string, workspaceId: string, actorId: string | null) {
    const p = await this.prisma.automationPolicy.findFirstOrThrow({ where: { id: policyId, workspaceId } });
    const account = await this.prisma.mailAccount.findFirst({ where: { id: p.mailAccountId, candidateId: p.candidateId } });
    if (!account) throw new AppError(422, 'ACCOUNT_NOT_OWNED', 'Politikadaki gönderici hesabı bu adaya ait değil');
    if (account.health !== 'ok') throw new AppError(422, 'ACCOUNT_UNHEALTHY', 'Gönderici hesabı geçersiz');
    if (account.provider === 'gmail' && !account.scopeSet.some((s) => s.includes('gmail.send'))) throw new AppError(422, 'SCOPE_MISSING', 'Gmail gönderim yetkisi yok');
    const docs = await this.prisma.documentVersion.findMany({ where: { id: { in: p.documentIds } } });
    if (p.documentIds.length === 0 || docs.length !== p.documentIds.length || docs.some((d) => d.candidateId !== p.candidateId || d.scanState !== 'clean'))
      throw new AppError(422, 'DOCUMENT_NOT_READY', 'Politikada en az bir taranmış ve adaya ait belge seçilmeli');
    if (!p.modeJobApplication && !p.modeGeneralIntent && !p.modeFollowUp) throw new AppError(422, 'NO_MODE', 'En az bir otomasyon anahtarı açılmalı');
    const version = p.version + 1;
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.automationPolicy.update({ where: { id: p.id }, data: { active: true, version, enabledAt: new Date(), disabledAt: null } });
      await tx.automationPolicyVersion.create({ data: { policyId: p.id, version, snapshot: policySnapshot(updated) as Prisma.InputJsonValue, reason: 'activate', createdById: actorId } });
      await this.outbox.emit({ workspaceId, eventType: 'automation.policy_activated', aggregateId: p.id, dedupKey: `policy-activate:${p.id}:${version}`, payload: { policyId: p.id } }, tx);
      return updated;
    });
  }

  async deactivate(policyId: string, workspaceId: string, actorId: string | null) {
    const p = await this.prisma.automationPolicy.findFirstOrThrow({ where: { id: policyId, workspaceId } });
    const version = p.version + 1;
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.automationPolicy.update({ where: { id: p.id }, data: { active: false, version, disabledAt: new Date() } });
      await tx.automationPolicyVersion.create({ data: { policyId: p.id, version, snapshot: policySnapshot(updated) as Prisma.InputJsonValue, reason: 'deactivate', createdById: actorId } });
      // Kuyruktaki otomatik gönderimler iptal edilir; worker da sağlayıcı çağrısından önce sürümü yeniden kontrol eder.
      const versions = await tx.automationPolicyVersion.findMany({ where: { policyId: p.id }, select: { id: true } });
      await this.sending.cancelQueued({ policyVersionId: { in: versions.map((v) => v.id) } }, 'POLICY_CHANGED', tx);
      return updated;
    });
  }

  private async currentVersionId(policy: AutomationPolicy) {
    const v = await this.prisma.automationPolicyVersion.findUnique({ where: { policyId_version: { policyId: policy.id, version: policy.version } } });
    return v?.id ?? null;
  }

  private async evaluateOpportunity(policy: AutomationPolicy, opportunityId: string, now = new Date()) {
    const opp = await this.prisma.opportunity.findFirst({
      where: { id: opportunityId, workspaceId: policy.workspaceId },
      include: {
        company: { include: { contacts: true } },
        job: { include: { listings: { include: { source: true } } } },
        searchProfile: true,
      },
    });
    if (!opp) return null;
    const intent = intentForCategory(opp.category);
    const autoIntent: 'job_application' | 'general_intent' = intent === 'job_application' ? 'job_application' : 'general_intent';
    const ws = await this.prisma.workspace.findUniqueOrThrow({ where: { id: policy.workspaceId } });
    const account = await this.prisma.mailAccount.findUnique({ where: { id: policy.mailAccountId } });

    let contacts = opp.company.contacts;
    if (opp.job?.applyEmail && intent === 'job_application') {
      const email = opp.job.applyEmail.toLowerCase();
      const official = opp.job.listings.some((l) => l.isOfficial);
      if (!contacts.find((c) => c.email === email)) {
        contacts = [...contacts, { id: 'job', email, kind: 'job_apply', verifiedAt: official ? now : null, suppressed: false } as any];
      }
    }
    const pool = intent === 'job_application' ? contacts : contacts.filter((c) => c.kind !== 'job_apply');
    const pickOpts = { preferVerified: true, domain: opp.company.canonicalDomain, aliases: opp.company.aliases, delivery: await this.models.deliveryFor(opp.company) };
    const contact = pickContact(pool.filter((c) => policy.allowedRecipientKinds.includes(c.kind)), pickOpts) ?? pickContact(pool, pickOpts);
    const docs = await this.prisma.documentVersion.findMany({ where: { id: { in: policy.documentIds }, workspaceId: policy.workspaceId } });
    const documentsReady = docs.length > 0 && docs.length === policy.documentIds.length && docs.every((d) => d.candidateId === policy.candidateId && d.scanState === 'clean' && !d.archived);
    const target = intent === 'job_application' && opp.job ? `job:${opp.job.canonicalKey}` : `company:${opp.companyId}:${istanbulDay(now).slice(0, 7)}`;
    const already = await this.prisma.applicationAttempt.findUnique({ where: { activeKey: activeKeyFor(policy.candidateId, target, intent) } });
    const cooldown = await this.sending.companyCooldownActive(policy.candidateId, opp.companyId, policy.companyCooldownDays);
    const limitKey = autoIntent === 'job_application' ? `auto:${policy.id}:job` : `auto:${policy.id}:intent`;
    const limit = autoIntent === 'job_application' ? policy.dailyLimit : policy.intentDailyLimit;
    const used = await this.usage.get(policy.workspaceId, limitKey, now);
    const suppressed = await this.sending.isSuppressed(policy.workspaceId, policy.candidateId, opp.companyId, contact?.email ?? null);
    const sourceHealthy = !opp.job || opp.job.listings.every((l) => ['healthy', 'unknown'].includes(l.source.health));

    const decision = evaluatePolicy({
      policy,
      emergencyStop: ws.automationPaused,
      intent: autoIntent,
      titleMatch: opp.titleMatch as any,
      job: opp.job ? { status: opp.job.status, lastVerifiedAt: opp.job.lastVerifiedAt, channel: opp.job.channel } : null,
      sourceHealthy,
      f: opp.f,
      q: opp.q,
      coverage: opp.coverage,
      mandatoryUnknown: opp.mandatoryUnknown,
      mandatoryFailed: ((opp.fBreakdown as any)?.conditions?.note ?? '').includes('karşılanmıyor'),
      location: opp.locationState,
      unknownLocationAction: opp.searchProfile.unknownLocationAction,
      contact: contact ? { kind: contact.kind, verified: contactVerifiedForSending(contact), suppressed: contact.suppressed } : null,
      documentsReady,
      alreadyApplied: !!already,
      companyCooldownActive: cooldown,
      dailyLimitReached: used >= limit,
      suppressed: !!suppressed,
      accountHealthy: !!account && account.health === 'ok' && account.candidateId === policy.candidateId,
      now,
      checkFreshness: false,
    });
    const sendAt = policy.sendImmediately ? now : nextSendSlot(now, policy.sendWindowStart, policy.sendWindowEnd, policy.sendDays);
    return { opp, intent, contact, docs, decision, account, sendAt };
  }

  /** Dry run: bugün hangi firmaya hangi içerik, dosya ve hesapla gönderileceğini gösterir; yan etkisizdir. */
  async dryRun(policyId: string, workspaceId: string): Promise<DryRunRow[]> {
    const policy = await this.prisma.automationPolicy.findFirstOrThrow({ where: { id: policyId, workspaceId } });
    const simulated = { ...policy, active: true };
    const opps = await this.prisma.opportunity.findMany({
      where: { workspaceId, searchProfileId: policy.searchProfileId, category: { notIn: ['excluded'] }, status: { notIn: ['dismissed', 'applied'] } },
      orderBy: [{ f: 'desc' }, { q: 'desc' }],
      take: 200,
    });
    const rows: DryRunRow[] = [];
    for (const o of opps) {
      const r = await this.evaluateOpportunity(simulated, o.id);
      if (!r) continue;
      const modeOn = r.intent === 'job_application' ? policy.modeJobApplication : policy.modeGeneralIntent;
      rows.push({
        opportunityId: o.id,
        company: r.opp.company.name,
        job: r.opp.job?.title ?? null,
        intent: r.intent,
        category: r.opp.category,
        recipient: r.contact?.email ?? null,
        recipientKind: r.contact?.kind ?? null,
        account: r.account?.accountEmail ?? null,
        documents: r.docs.map((d) => d.label),
        f: r.opp.f,
        q: r.opp.q,
        coverage: r.opp.coverage,
        decision: r.decision,
        reasonLabels: r.decision.reasons.map((c) => REASON_LABELS[c]),
        wouldSendAt: r.decision.eligible && modeOn ? r.sendAt.toISOString() : null,
      });
    }
    return rows.sort((a, b) => Number(b.decision.eligible) - Number(a.decision.eligible));
  }

  /** Yeni/güncellenen fırsat için aktif politikaları çalıştırır. */
  async onOpportunity(opportunityId: string) {
    const opp = await this.prisma.opportunity.findUnique({ where: { id: opportunityId } });
    if (!opp || opp.status === 'dismissed' || opp.status === 'applied' || opp.category === 'excluded') return [];
    const policies = await this.prisma.automationPolicy.findMany({ where: { workspaceId: opp.workspaceId, searchProfileId: opp.searchProfileId, active: true } });
    const results = [];
    for (const policy of policies) {
      const r = await this.evaluateOpportunity(policy, opportunityId);
      if (!r) continue;
      const modeOn = r.intent === 'job_application' ? policy.modeJobApplication : policy.modeGeneralIntent;
      if (!modeOn) continue;
      const existingDraft = await this.prisma.applicationDraft.findFirst({ where: { opportunityId, candidateId: policy.candidateId, status: { in: ['draft', 'needs_review', 'queued', 'sent'] } } });
      if (existingDraft) continue;
      const soft = r.decision.reasons.every((c) => REVIEW_REASONS.includes(c));
      if (!r.decision.eligible && !soft) {
        results.push({ policyId: policy.id, action: 'skipped', reasons: r.decision.reasons });
        continue;
      }
      await this.refreshCandidateFacts(policy.candidateId);
      const draft = await this.drafting.create({
        workspaceId: policy.workspaceId,
        candidateId: policy.candidateId,
        companyId: r.opp.companyId,
        jobId: r.intent === 'job_application' ? r.opp.jobId : null,
        opportunityId,
        intentType: r.intent,
        mailAccountId: policy.mailAccountId,
        contactId: r.contact && r.contact.id !== 'job' ? r.contact.id : null,
        documentIds: policy.documentIds,
        origin: 'automation',
        allowManualAi: false,
      });
      await this.prisma.opportunity.update({ where: { id: opportunityId }, data: { status: 'drafted' } });
      if (!r.decision.eligible) {
        await this.prisma.applicationDraft.update({ where: { id: draft.id }, data: { status: 'needs_review', blockedReasons: r.decision.reasons.map((c) => REASON_LABELS[c]) } });
        await this.outbox.emit({ workspaceId: policy.workspaceId, eventType: 'notify', aggregateId: draft.id, dedupKey: `review:${draft.id}`, payload: { type: 'draft_ready', title: 'İnceleme bekleyen taslak', body: `${r.opp.company.name}: ${r.decision.reasons.map((c) => REASON_LABELS[c]).join(', ')}`, link: `/opportunities?id=${opportunityId}` } });
        results.push({ policyId: policy.id, action: 'review', draftId: draft.id, reasons: r.decision.reasons });
        continue;
      }
      if (draft.status === 'needs_review') {
        results.push({ policyId: policy.id, action: 'review', draftId: draft.id, reasons: draft.blockedReasons });
        continue;
      }
      if (!policy.autoSend) {
        await this.outbox.emit({ workspaceId: policy.workspaceId, eventType: 'notify', aggregateId: draft.id, dedupKey: `ready:${draft.id}`, payload: { type: 'draft_ready', title: 'Başvuruya hazır', body: `${r.opp.company.name}${r.opp.job ? ` — ${r.opp.job.title}` : ''}`, link: `/opportunities?id=${opportunityId}` } });
        results.push({ policyId: policy.id, action: 'ready', draftId: draft.id });
        continue;
      }
      try {
        const { attempt } = await this.sending.queueSend({
          workspaceId: policy.workspaceId,
          userId: null,
          draftId: draft.id,
          idempotencyKey: `auto:${hashObject({ p: policy.id, v: policy.version, o: opportunityId }).slice(0, 32)}`,
          sendMode: 'auto',
          policyVersionId: await this.currentVersionId(policy),
          mailAccountId: policy.mailAccountId,
          scheduledAt: r.sendAt,
        });
        results.push({ policyId: policy.id, action: 'queued', attemptId: attempt.id });
      } catch (e) {
        const code = e instanceof AppError ? e.code : 'ERROR';
        await this.prisma.applicationDraft.update({ where: { id: draft.id }, data: { status: 'needs_review', blockedReasons: { push: code } } });
        results.push({ policyId: policy.id, action: 'review', draftId: draft.id, reasons: [code] });
      }
    }
    return results;
  }

  async prepareFromHome(workspaceId: string, opportunityId: string, userId: string | null, fresh = false) {
    const opp = await this.prisma.opportunity.findFirst({ where: { id: opportunityId, workspaceId }, include: { searchProfile: true, company: { include: { contacts: true } }, job: true } });
    if (!opp || opp.status === 'dismissed') return null;
    let draft = await this.prisma.applicationDraft.findFirst({ where: { opportunityId, candidateId: opp.searchProfile.candidateId, status: { in: ['draft', 'needs_review', 'queued', 'sent'] } }, orderBy: { createdAt: 'desc' } });
    if (!draft) {
      const intent = intentForOpportunity(opp);
      await this.refreshCandidateFacts(opp.searchProfile.candidateId);
      draft = await this.drafting.create({
        workspaceId,
        candidateId: opp.searchProfile.candidateId,
        companyId: opp.companyId,
        jobId: intent === 'general_intent' ? null : opp.jobId,
        opportunityId,
        intentType: intent,
        documentIds: await this.defaultDocumentIds(opp.searchProfile.candidateId),
        origin: 'manual',
        createdById: userId,
        allowManualAi: false,
        fresh,
      });
      await this.prisma.opportunity.update({ where: { id: opportunityId }, data: { status: 'drafted' } });
    }
    if (['draft', 'needs_review'].includes(draft.status)) draft = await this.fillMissingRecipient(draft, opp.job?.applyEmail ?? pickContact(opp.company.contacts, { domain: opp.company.canonicalDomain, aliases: opp.company.aliases, delivery: await this.models.deliveryFor(opp.company) })?.email ?? null, userId);
    return { opp, draft };
  }

  async fillMissingRecipient(draft: ApplicationDraft, recipient: string | null, userId: string | null) {
    if (!recipient) return draft;
    const rev = await this.drafting.currentRevision(draft.id);
    if (!rev || rev.toEmail) return draft;
    await this.drafting.addRevision(draft, { toEmail: recipient, subject: rev.subject, body: rev.body, documentIds: rev.documentIds, links: rev.links }, { createdById: userId, generator: 'system:recipient', sourceRefs: rev.sourceRefs });
    return this.prisma.applicationDraft.findUniqueOrThrow({ where: { id: draft.id } });
  }

  async applyFromHome(workspaceId: string, opportunityId: string, userId: string | null) {
    const prepared = await this.prepareFromHome(workspaceId, opportunityId, userId);
    if (!prepared) return { action: 'skipped' };
    const { opp, draft } = prepared;
    if (['queued', 'sent'].includes(draft.status)) return { action: 'already_sent', draftId: draft.id };
    const label = `${opp.company.name}${opp.job ? ` — ${opp.job.title}` : ''}`;
    try {
      const { attempt } = await this.sending.queueSend({
        workspaceId,
        userId,
        draftId: draft.id,
        idempotencyKey: `home:${draft.id}:${draft.currentRevision}`,
        expectedRevision: draft.currentRevision,
        sendMode: 'manual',
      });
      return { action: 'queued', attemptId: attempt.id };
    } catch (e) {
      const reason = errorMessage(e);
      await this.prisma.applicationDraft.update({ where: { id: draft.id }, data: { status: 'needs_review', blockedReasons: { push: reason } } });
      await this.outbox.emit({ workspaceId, eventType: 'notify', aggregateId: draft.id, dedupKey: `home-apply-failed:${draft.id}:${Date.now()}`, payload: { type: 'draft_ready', title: `Gönderilemedi: ${label}`, body: reason, link: `/opportunities?id=${opportunityId}` } });
      return { action: 'review', draftId: draft.id, reason };
    }
  }

  /** Mail adresi bilinen ve henüz yazısı olmayan fırsatlar; kategori önceliği ve skora göre sıralı. */
  async predraftCandidates(policy: AutomationPolicy, limit: number) {
    if (limit <= 0) return [];
    const opps = await this.prisma.opportunity.findMany({
      where: {
        workspaceId: policy.workspaceId,
        searchProfileId: policy.searchProfileId,
        category: { in: PREDRAFT_CATEGORIES },
        status: { notIn: ['dismissed', 'applied'] },
        company: { excluded: false },
        OR: [{ job: { applyEmail: { not: null } } }, { company: { contacts: { some: { suppressed: false, kind: { in: SENDABLE_CONTACT_KINDS } } } } }],
      },
      orderBy: [{ f: { sort: 'desc', nulls: 'last' } }, { computedAt: 'desc' }],
      take: limit * PREDRAFT_SCAN_MULTIPLIER,
      select: { id: true, category: true },
    });
    const drafted = new Set(
      (await this.prisma.applicationDraft.findMany({ where: { opportunityId: { in: opps.map((o) => o.id) }, status: { in: ACTIVE_DRAFT_STATUSES } }, select: { opportunityId: true } })).map((d) => d.opportunityId),
    );
    return opps
      .filter((o) => !drafted.has(o.id))
      .sort((a, b) => PREDRAFT_CATEGORIES.indexOf(a.category) - PREDRAFT_CATEGORIES.indexOf(b.category))
      .slice(0, limit)
      .map((o) => o.id);
  }

  async pendingPredrafts(workspaceId: string) {
    const policy = await this.prisma.automationPolicy.findFirst({ where: { workspaceId, active: true }, orderBy: { createdAt: 'desc' } });
    return policy ? (await this.predraftCandidates(policy, 100)).length : 0;
  }

  async defaultDocumentIds(candidateId: string) {
    const docs = await this.prisma.documentVersion.findMany({ where: { candidateId, archived: false, scanState: 'clean', type: { in: ['cv', 'portfolio'] } }, orderBy: { createdAt: 'desc' } });
    const latestByType = new Map<string, string>();
    for (const d of docs) if (!latestByType.has(d.type)) latestByType.set(d.type, d.id);
    return [...latestByType.values()];
  }

  /** 7 iş günü sonra takip: varsayılan yalnızca taslak; politika takip anahtarı açıksa en fazla bir otomatik takip. */
  async processFollowUps(now = new Date()) {
    const due = await this.prisma.followUp.findMany({ where: { state: 'pending', dueAt: { lte: now } }, take: 100 });
    let drafted = 0;
    for (const f of due) {
      try {
        drafted += await this.processFollowUp(f, now);
      } catch (e) {
        // Tek bir bozuk kayıt (silinmiş aday/firma/hesap) diğer takipleri durdurmaz.
        this.logger.warn(`Takip işlenemedi (${f.id}): ${(e as Error).message}`);
        await this.prisma.followUp.update({ where: { id: f.id }, data: { state: 'cancelled', cancellationReason: `Hata: ${(e as Error).message}`.slice(0, 300) } });
      }
    }
    return { drafted };
  }

  private async processFollowUp(f: { id: string; attemptId: string; workspaceId: string }, now: Date): Promise<number> {
    let drafted = 0;
    {
      const attempt = await this.prisma.applicationAttempt.findUnique({ where: { id: f.attemptId } });
      if (!attempt || attempt.state !== 'provider_accepted') {
        await this.prisma.followUp.update({ where: { id: f.id }, data: { state: 'cancelled', cancellationReason: `Başvuru durumu: ${attempt?.state ?? 'yok'}` } });
        return 0;
      }
      if (await this.sending.isSuppressed(attempt.workspaceId, attempt.candidateId, attempt.companyId, attempt.toEmail)) {
        await this.prisma.followUp.update({ where: { id: f.id }, data: { state: 'cancelled', cancellationReason: 'SUPPRESSED' } });
        return 0;
      }
      const original = await this.prisma.draftRevision.findUnique({ where: { draftId_revision: { draftId: attempt.draftId, revision: attempt.draftRevision } } });
      const draft = await this.drafting.create({
        workspaceId: attempt.workspaceId,
        candidateId: attempt.candidateId,
        companyId: attempt.companyId,
        jobId: attempt.jobId,
        intentType: 'follow_up',
        mailAccountId: attempt.mailAccountId,
        origin: 'follow_up',
        followUpOfId: attempt.id,
        documentIds: [],
        allowManualAi: false,
        subjectTemplate: original ? `Re: ${original.subject}` : undefined,
        bodyTemplate: original ? 'Merhaba,\n\nBirkaç gün önce ilettiğim başvurumla ilgili kısa bir hatırlatma yapmak istedim. Ek bilgi gerekirse memnuniyetle paylaşırım.\n\nTeşekkürler,\n{signature}' : undefined,
      });
      if (attempt.toEmail && original?.toEmail !== undefined) {
        const cur = await this.drafting.currentRevision(draft.id);
        if (cur && cur.toEmail !== attempt.toEmail) {
          const d = await this.prisma.applicationDraft.findUniqueOrThrow({ where: { id: draft.id } });
          await this.drafting.addRevision(d, { toEmail: attempt.toEmail, subject: cur.subject, body: cur.body, documentIds: [], links: cur.links }, { createdById: null, generator: cur.generator });
        }
      }
      await this.prisma.followUp.update({ where: { id: f.id }, data: { state: 'drafted', draftId: draft.id } });
      drafted++;
      let autoSent = false;
      if (attempt.policyVersionId) {
        const pv = await this.prisma.automationPolicyVersion.findUnique({ where: { id: attempt.policyVersionId }, include: { policy: true } });
        if (pv?.policy.active && pv.policy.modeFollowUp) {
          try {
            await this.sending.queueSend({
              workspaceId: attempt.workspaceId,
              userId: null,
              draftId: draft.id,
              idempotencyKey: `followup:${f.id}:${randomToken(4)}`,
              sendMode: 'auto',
              policyVersionId: (await this.currentVersionId(pv.policy)) ?? undefined,
              mailAccountId: attempt.mailAccountId,
              scheduledAt: nextSendSlot(now, pv.policy.sendWindowStart, pv.policy.sendWindowEnd, pv.policy.sendDays),
            });
            autoSent = true;
          } catch (e) {
            this.logger.warn(`Takip otomatik kuyruğa alınamadı: ${(e as Error).message}`);
          }
        }
      }
      if (!autoSent) {
        await this.outbox.emit({ workspaceId: attempt.workspaceId, eventType: 'notify', aggregateId: draft.id, dedupKey: `followup-draft:${f.id}`, payload: { type: 'draft_ready', title: 'Takip taslağı hazır', body: 'Yanıt gelmeyen başvuru için takip taslağı oluşturuldu.', link: `/applications?attempt=${attempt.id}` } });
      }
    }
    return drafted;
  }

  /** İnsan yanıtı, ret, bounce veya "iletişime geçmeyin" otomatik takibi iptal eder. */
  async cancelFollowUps(attemptId: string, reason: string) {
    await this.prisma.followUp.updateMany({ where: { attemptId, state: 'pending' }, data: { state: 'cancelled', cancellationReason: reason } });
    const drafts = await this.prisma.applicationDraft.findMany({ where: { followUpOfId: attemptId, status: { in: ['draft', 'needs_review', 'queued'] } } });
    for (const d of drafts) {
      await this.prisma.applicationAttempt.updateMany({ where: { draftId: d.id, state: 'queued' }, data: { state: 'cancelled', stateReason: reason, activeKey: null } });
      await this.prisma.applicationDraft.update({ where: { id: d.id }, data: { status: 'cancelled' } });
    }
  }
}
