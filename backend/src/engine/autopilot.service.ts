import { Injectable, Logger } from '@nestjs/common';
import { ApplicationAttempt, AutopilotAction, InboundMessage, Prisma } from '@prisma/client';
import { AppError, errorMessage } from '../common/errors';
import { OutboxService } from '../common/outbox.service';
import { PrismaService } from '../common/prisma.service';
import { nextSendSlot } from '../common/time';
import { AutopilotActionItem, AutopilotOverview, PipelineCounts } from '../contracts/home';
import { ServerShape } from '../contracts/wire';
import { AiClass } from '../domain/ai-budget';
import { AUTOPILOT_LOOKBACK_DAYS, AutopilotMode, AutopilotState, AutopilotStep, decideFix, FixContext, FixDecision, needsAi } from '../domain/autopilot';
import { contactSearchPlan } from '../domain/contact-search';
import { isValidEmail, recipientScore, SENDABLE_CONTACT_KINDS } from '../domain/contacts';
import { INBOUND_GROUP, INBOUND_LABELS, InboundCategory } from '../domain/inbound';
import { AddressBookService } from './address-book.service';
import { withAiClass } from './ai/ai-context';
import { AiService } from './ai/ai.service';
import { InboxService } from './inbox.service';
import { LearnedModelsService } from './learned-models.service';
import { ResearchMeta, ResearchService } from './research.service';

const DAY_MS = 86_400_000;
const DEFAULT_WINDOW = { start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5] };
const DECIDED_GROUPS = new Set(['failed', 'action', 'review']);
const SENT_ONWARD_STATES = ['provider_accepted', 'submission_unknown', 'replied', 'bounced', 'outcome_recorded'];
const PENDING_RETRY_STATES = ['queued', 'sending', ...SENT_ONWARD_STATES];
const RUNNING_STALE_MS = 30 * 60_000;
const SWEEP_LIMIT = 200;
const LOG_LIMIT = 100;
const RETURNS_LINK = '/home?tab=donusler';

/** Onay bekleyen öneri onay listesine, gönderilen düzeltme yeni başvuruya, diğer kararlar dönen maile götürür. */
const linkOf = (action: Pick<AutopilotAction, 'state' | 'resultAttemptId' | 'inboundMessageId'>) =>
  action.state === 'proposed' ? RETURNS_LINK : action.state === 'executed' && action.resultAttemptId ? `/applications?attempt=${action.resultAttemptId}` : `/inbox?id=${action.inboundMessageId}`;
const MAX_FIX_TEXT = 2_500;
const MAX_FIX_BODY = 5_000;
const EMAIL_IN_TEXT = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g;
/** Otomatik gönderilemeyen ama kullanıcının onayıyla gönderilebilecek durumlar; diğer hatalar öneriyi geçersiz kılar. */
const APPROVABLE_BLOCKERS = ['CONTACT_UNVERIFIED', 'JOB_NOT_OPEN', 'DAILY_LIMIT'];
const AUTO_RESERVED_KIND: Record<string, string> = { general: 'genel iletişim adresi', named_recruiter: 'bir çalışanın adresi' };

type Company = { id: string; name: string; canonicalDomain: string | null; aliases: string[]; researchMeta: Prisma.JsonValue; contacts: { email: string; kind: string; suppressed: boolean; verifiedAt: Date | null; verifiedBy: string | null; sourceUrl: string | null }[] };

interface Situation {
  message: InboundMessage;
  attempt: ApplicationAttempt;
  company: Company;
  category: InboundCategory;
  revision: { subject: string; body: string; documentIds: string[] };
  documents: { id: string; type: string; fileName: string; size: number }[];
  suggestedEmail: string | null;
  alternatives: string[];
  context: FixContext;
}

interface ResendPlan {
  toEmail: string;
  attachments: 'all' | 'cv_only' | 'none';
  delayDays: number;
  subject?: string | null;
  body?: string | null;
  generator?: string;
}

type Result =
  | { state: 'executed'; step: AutopilotStep; toEmail: string; resultAttemptId: string; detail: string }
  | { state: Exclude<AutopilotState, 'executed' | 'running'>; step: AutopilotStep; detail: string; toEmail?: string | null; plan?: ResendPlan | null };

/**
 * Otopilot: mail dönüşü geldiğinde kategoriye göre karar verir (domain/autopilot), "Otomatik başvur" açıksa uygular,
 * kapalıysa onaya sunar. Her karar AutopilotAction kaydıdır; kayıt hem onay kuyruğu hem de yapılanların günlüğüdür.
 */
@Injectable()
export class AutopilotService {
  private readonly logger = new Logger('Autopilot');

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
    private readonly inbox: InboxService,
    private readonly research: ResearchService,
    private readonly addressBook: AddressBookService,
    private readonly outbox: OutboxService,
    private readonly models: LearnedModelsService,
  ) {}

  async mode(workspaceId: string): Promise<AutopilotMode> {
    const ws = await this.prisma.workspace.findUnique({ where: { id: workspaceId }, select: { automationPaused: true } });
    if (!ws || ws.automationPaused) return 'stopped';
    const autoSend = await this.prisma.automationPolicy.count({ where: { workspaceId, active: true, autoSend: true } });
    return autoSend ? 'auto' : 'approval';
  }

  /** Yeni gelen dönüş: karar verilir; adres araması hemen yapılır, gönderim "Otomatik başvur" açıksa kendiliğinden gider. */
  async onInbound(messageId: string) {
    const message = await this.prisma.inboundMessage.findUnique({ where: { id: messageId } });
    if (!message) return { status: 'missing' as const };
    const decided = await this.decide(message, { arrival: true });
    if (decided.status === 'recorded') await this.announce(decided.action, decided.company);
    return { status: decided.status, state: decided.status === 'recorded' ? decided.action.state : null };
  }

  /**
   * Hakkında karar verilmemiş açık dönüşler için öneri üretir. Yapay zekâ harcamaz ve hiçbir şey göndermez: gelişinde
   * işlenememiş ya da otopilottan önce gelmiş dönüşler kullanıcının onayına sunulur.
   */
  async sweep(workspaceId?: string, now = new Date()) {
    await this.prisma.autopilotAction.updateMany({ where: { state: 'running', updatedAt: { lt: new Date(now.getTime() - RUNNING_STALE_MS) }, ...(workspaceId ? { workspaceId } : {}) }, data: { state: 'proposed' } });
    const decided = await this.prisma.autopilotAction.findMany({ where: workspaceId ? { workspaceId } : {}, select: { inboundMessageId: true } });
    const messages = await this.prisma.inboundMessage.findMany({
      where: {
        source: 'imap',
        status: 'open',
        attemptId: { not: null },
        receivedAt: { gte: new Date(now.getTime() - AUTOPILOT_LOOKBACK_DAYS * DAY_MS) },
        id: { notIn: decided.map((d) => d.inboundMessageId) },
        ...(workspaceId ? { workspaceId } : {}),
      },
      orderBy: { receivedAt: 'desc' },
      take: SWEEP_LIMIT,
    });
    const seen = new Set<string>();
    const proposed = new Map<string, number>();
    for (const message of messages) {
      if (seen.has(message.attemptId!)) continue;
      seen.add(message.attemptId!);
      try {
        const r = await this.decide(message, { arrival: false });
        if (r.status === 'recorded' && r.action.state === 'proposed') proposed.set(message.workspaceId, (proposed.get(message.workspaceId) ?? 0) + 1);
      } catch (e) {
        this.logger.warn(`Dönüş için karar verilemedi (${message.id}): ${errorMessage(e)}`);
      }
    }
    for (const [ws, count] of proposed) {
      await this.outbox.emit({
        workspaceId: ws,
        eventType: 'notify',
        aggregateId: ws,
        dedupKey: `autopilot-sweep:${ws}:${now.getTime()}`,
        payload: { type: 'autopilot', title: `Otopilot ${count} mail dönüşü için öneri hazırladı`, body: 'Önerileri Mail dönüşleri bölümünde onaylayabilir ya da vazgeçebilirsin.', link: RETURNS_LINK },
      });
    }
    return { reviewed: seen.size, proposed: [...proposed.values()].reduce((sum, n) => sum + n, 0) };
  }

  private async decide(message: InboundMessage, opts: { arrival: boolean }) {
    const category = (message.category ?? 'unknown') as InboundCategory;
    if (!message.attemptId || message.status !== 'open' || !DECIDED_GROUPS.has(INBOUND_GROUP[category])) return { status: 'skipped' as const };
    if (await this.prisma.autopilotAction.findUnique({ where: { inboundMessageId: message.id }, select: { id: true } })) return { status: 'skipped' as const };
    if (await this.prisma.applicationAttempt.count({ where: { retryOfId: message.attemptId, state: { in: PENDING_RETRY_STATES } } })) return { status: 'skipped' as const };
    const situation = await this.situationOf(message);
    if (!situation) return { status: 'skipped' as const };
    const decision = decideFix(situation.context);
    if (decision.step === 'none') return { status: 'skipped' as const };
    const mode = await this.mode(message.workspaceId);
    const auto = opts.arrival && mode === 'auto';
    const run = await withAiClass('fix', () => this.settle(situation, decision, { arrival: opts.arrival, auto }));
    const action = await this.record(situation, run.value, { aiTasks: run.calls, mode: 'auto' });
    if (!action) return { status: 'skipped' as const };
    return { status: 'recorded' as const, action, company: situation.company.name };
  }

  /** Kararı sonuca bağlar: gönderir, onaya sunar ya da kullanıcıya ne yapılacağını söyler. */
  private async settle(situation: Situation, decision: FixDecision, opts: { arrival: boolean; auto: boolean }): Promise<Result> {
    if (decision.step === 'none') return { state: 'info', step: 'stop', detail: 'Bu dönüş için yapılacak bir şey yok.' };
    if (decision.step === 'use_link' || decision.step === 'stop') return { state: 'info', step: decision.step, detail: decision.why };
    if (decision.step === 'ai_review') return { state: 'proposed', step: 'ai_review', detail: decision.why };
    if (decision.step === 'research') {
      if (!opts.arrival) return { state: 'proposed', step: 'research', detail: decision.why };
      const searched = await this.searchAddress(situation, null);
      if (!searched.ok) return { state: 'proposed', step: 'research', detail: `${decision.why} Arama şu an yapılamadı; onaylarsan yeniden denenir.` };
      const next = decideFix({ ...searched.situation.context, canResearch: false });
      return this.settle(searched.situation, next, opts);
    }
    if (decision.step === 'fix_format') {
      if (!opts.auto) return { state: 'proposed', step: 'fix_format', detail: decision.why };
      return this.reviseAndSend(situation, null, { auto: true, why: decision.why });
    }
    const plan: ResendPlan = { toEmail: decision.toEmail, attachments: decision.attachments, delayDays: decision.delayDays };
    if (!opts.auto) return { state: 'proposed', step: 'resend', detail: decision.why, toEmail: plan.toEmail, plan };
    return this.send(situation, plan, { userId: null, auto: true, why: decision.why });
  }

  private async send(situation: Situation, plan: ResendPlan, by: { userId: string | null; auto: boolean; why: string }): Promise<Result> {
    const { attempt, revision, documents } = situation;
    const kept = plan.attachments === 'none' ? [] : plan.attachments === 'cv_only' ? documents.filter((d) => d.type === 'cv') : documents;
    const reserved = by.auto ? await this.reservedForApproval(situation, plan.toEmail) : null;
    if (reserved) return { state: 'proposed', step: 'resend', toEmail: plan.toEmail, plan, detail: `${by.why} ${reserved} Onaylarsan gönderilir.` };
    try {
      const queued = await this.inbox.resend(
        attempt.workspaceId,
        by.userId,
        attempt.id,
        { toEmail: plan.toEmail, subject: plan.subject ?? revision.subject, body: plan.body ?? revision.body, documentIds: kept.map((d) => d.id), generator: plan.generator },
        { mode: by.auto ? 'autopilot' : 'manual', scheduledAt: await this.sendSlot(attempt.workspaceId, plan.delayDays, by.auto) },
      );
      return { state: 'executed', step: 'resend', toEmail: queued.toEmail, resultAttemptId: queued.attemptId, detail: by.why };
    } catch (e) {
      const code = e instanceof AppError ? e.code : null;
      if (by.auto && code && APPROVABLE_BLOCKERS.includes(code)) {
        return { state: 'proposed', step: 'resend', toEmail: plan.toEmail, plan, detail: `${by.why} Kendiliğinden gönderilemedi: ${errorMessage(e)}. Onaylarsan gönderilir.` };
      }
      return { state: 'failed', step: 'resend', toEmail: plan.toEmail, plan, detail: `${by.why} Gönderilemedi: ${errorMessage(e)}` };
    }
  }

  /**
   * Kendiliğinden gönderim yalnızca otomatik başvurunun izin verdiği adres türlerine (varsayılan: İK ve ilan başvuru
   * adresi) yapılır; genel iletişim adresi ya da bir çalışanın adresi kullanıcının onayını bekler.
   */
  private async reservedForApproval(situation: Situation, toEmail: string): Promise<string | null> {
    const policy = await this.prisma.automationPolicy.findFirst({ where: { workspaceId: situation.attempt.workspaceId, active: true, autoSend: true }, orderBy: { createdAt: 'desc' }, select: { allowedRecipientKinds: true } });
    const contact = situation.company.contacts.find((c) => c.email.toLowerCase() === toEmail.toLowerCase());
    if (!policy || !contact) return 'Bu adres firmanın kayıtlı adresleri arasında olmadığı için kendiliğinden gönderilmedi.';
    if (!policy.allowedRecipientKinds.includes(contact.kind)) return `Bu adres ${AUTO_RESERVED_KIND[contact.kind] ?? 'İK adresi değil'}; kendiliğinden gönderilmedi.`;
    return null;
  }

  /** Otomatik düzeltme: gönderim penceresinin içinde hemen, dışında pencerenin başında. Onaylanan düzeltme beklemez. */
  private async sendSlot(workspaceId: string, delayDays: number, auto: boolean): Promise<Date | null> {
    if (!auto && !delayDays) return null;
    const policy = await this.prisma.automationPolicy.findFirst({ where: { workspaceId }, orderBy: [{ active: 'desc' }, { createdAt: 'desc' }] });
    const base = new Date(Date.now() + delayDays * DAY_MS);
    if (policy?.sendImmediately && !delayDays) return null;
    return nextSendSlot(base, policy?.sendWindowStart ?? DEFAULT_WINDOW.start, policy?.sendWindowEnd ?? DEFAULT_WINDOW.end, policy?.sendDays ?? DEFAULT_WINDOW.days);
  }

  private async searchAddress(situation: Situation, userId: string | null): Promise<{ ok: boolean; situation: Situation }> {
    const { attempt, message, company } = situation;
    const r = await this.research.findDetails(company.id, userId, { deep: true, avoidEmails: attempt.toEmail ? [attempt.toEmail] : [], since: message.receivedAt });
    if (r.status !== 'succeeded' && r.status !== 'skipped') return { ok: false, situation };
    return { ok: true, situation: (await this.situationOf(message)) ?? situation };
  }

  /**
   * Yapay zekâ dönen maili ve önceki başvuruyu okur; firmanın istediği biçime göre yazıyı düzenler ya da (nedeni belirsiz
   * dönüşlerde) ne yapılacağına karar verir. Alıcı yalnızca firmanın bilinen adreslerinden ya da dönen mailde geçen
   * adreslerden seçilebilir.
   */
  private async reviseAndSend(situation: Situation, userId: string | null, by: { auto: boolean; why: string }): Promise<Result> {
    const { attempt, message, company, category, revision, documents, suggestedEmail } = situation;
    const step: AutopilotStep = category === 'format_issue' ? 'fix_format' : 'ai_review';
    const inboundText = message.bodyText ?? '';
    const candidates = [...(suggestedEmail ? [{ email: suggestedEmail, source: 'firmanın yanıtında önerildi' }] : []), ...situation.alternatives.map((email) => ({ email, source: 'firmanın bilinen adresi' }))];
    const r = await this.ai
      .run({
        workspaceId: attempt.workspaceId,
        kind: 'inbound_fix',
        input: {
          company: company.name,
          category,
          label: INBOUND_LABELS[category],
          reason: message.reason,
          sentTo: attempt.toEmail,
          candidates,
          suggestedEmail,
          attachments: documents.map((d) => ({ type: d.type, fileName: d.fileName, sizeMB: Math.round((d.size / 1048576) * 10) / 10 })),
          inboundSubject: message.subject,
          inboundText: inboundText.slice(0, MAX_FIX_TEXT),
          subject: revision.subject,
          body: revision.body.slice(0, MAX_FIX_BODY),
        },
        allowManual: false,
        allowTemplate: false,
        useCache: false,
        entityType: 'ApplicationAttempt',
        entityId: attempt.id,
        createdById: userId,
      })
      .catch(() => null);
    const advice = (r?.status === 'succeeded' ? r.output : null) as { action: 'resend' | 'research' | 'skip'; toEmail?: string | null; subject?: string | null; body?: string | null; attachments: 'all' | 'cv_only' | 'none'; reason: string } | null;
    if (!advice) return { state: 'proposed', step, detail: `${by.why} Yapay zekâ şu an kullanılamıyor; daha sonra yeniden onaylayabilirsin.` };
    if (advice.action === 'skip') return { state: 'info', step, detail: advice.reason || 'Bu dönüş düzeltilerek yeniden gönderilemiyor.' };

    const addressUsable = !(await this.addressBook.isDead(attempt.toEmail)) && !company.contacts.some((c) => c.email === attempt.toEmail && c.suppressed);
    const allowed = new Set([...candidates.map((c) => c.email), ...(inboundText.toLowerCase().match(EMAIL_IN_TEXT) ?? []), ...(attempt.toEmail && addressUsable ? [attempt.toEmail] : [])]);
    let current = situation;
    let toEmail = advice.action === 'resend' && advice.toEmail && allowed.has(advice.toEmail.toLowerCase()) ? advice.toEmail.toLowerCase() : null;
    if (!toEmail && category === 'format_issue' && attempt.toEmail && addressUsable) toEmail = attempt.toEmail;
    if (!toEmail) {
      const searched = await this.searchAddress(situation, userId);
      current = searched.situation;
      toEmail = current.alternatives[0] ?? null;
      if (!toEmail) return { state: 'info', step, detail: searched.ok ? 'Firmanın kullanılabilir başka bir adresi bulunamadı; diğer başvuru kanallarını kullanabilirsin.' : 'Yeni adres araması şu an yapılamadı.' };
    }
    const edited = !!(advice.subject || advice.body);
    const notes = [edited ? 'konu/metin firmanın talimatına göre düzenlendi' : null, advice.attachments === 'cv_only' ? 'yalnızca CV eklendi' : advice.attachments === 'none' ? 'eksiz gönderildi' : null].filter(Boolean);
    const why = [advice.reason || by.why, notes.length ? `(${notes.join(', ')})` : ''].filter(Boolean).join(' ');
    return this.send(current, { toEmail, attachments: advice.attachments, delayDays: 0, subject: advice.subject, body: advice.body, generator: edited ? 'ai:autopilot' : undefined }, { userId, auto: by.auto, why });
  }

  private async situationOf(message: InboundMessage): Promise<Situation | null> {
    const attempt = message.attemptId ? await this.prisma.applicationAttempt.findUnique({ where: { id: message.attemptId } }) : null;
    if (!attempt || !SENT_ONWARD_STATES.includes(attempt.state)) return null;
    const company = await this.prisma.company.findUnique({
      where: { id: attempt.companyId },
      select: { id: true, name: true, canonicalDomain: true, aliases: true, researchMeta: true, contacts: { select: { email: true, kind: true, suppressed: true, verifiedAt: true, verifiedBy: true, sourceUrl: true } } },
    });
    const revision = await this.prisma.draftRevision.findUnique({ where: { draftId_revision: { draftId: attempt.draftId, revision: attempt.draftRevision } } });
    if (!company || !revision) return null;
    const category = (message.category ?? 'unknown') as InboundCategory;
    const documentIds = await this.inbox.currentDocuments(attempt.candidateId, revision.documentIds);
    const documents = await this.prisma.documentVersion.findMany({ where: { id: { in: documentIds } }, select: { id: true, type: true, fileName: true, size: true } });
    const sentTo = attempt.toEmail?.toLowerCase() ?? null;
    const suggested = message.suggestedEmail?.toLowerCase() ?? null;
    const suggestedEmail = suggested && suggested !== sentTo && isValidEmail(suggested) && !(await this.addressBook.isDead(suggested)) && !company.contacts.some((c) => c.email === suggested && c.suppressed) ? suggested : null;
    const dead = await this.addressBook.deadAmong(company.contacts.map((c) => c.email));
    const scoring = { domain: company.canonicalDomain, aliases: company.aliases, preferVerified: true, delivery: await this.models.deliveryFor(company) };
    const alternatives = company.contacts
      .filter((c) => !c.suppressed && !dead.has(c.email) && SENDABLE_CONTACT_KINDS.includes(c.kind) && isValidEmail(c.email) && c.email !== sentTo && c.email !== suggestedEmail)
      .sort((a, b) => Number(!!b.verifiedAt) - Number(!!a.verifiedAt) || recipientScore(b, scoring) - recipientScore(a, scoring))
      .map((c) => c.email.toLowerCase());
    const chain = await this.chainOf(attempt);
    return {
      message,
      attempt,
      company,
      category,
      revision,
      documents,
      suggestedEmail,
      alternatives,
      context: {
        category,
        sentTo,
        suggestedEmail,
        alternatives,
        attachments: { cv: documents.filter((d) => d.type === 'cv').length, other: documents.filter((d) => d.type !== 'cv').length },
        autoFixes: chain.filter((a) => a.sendMode === 'autopilot').length,
        retriedSameAddress: chain.slice(1).some((a) => !!sentTo && a.toEmail?.toLowerCase() === sentTo),
        canResearch: contactSearchPlan(company.researchMeta as ResearchMeta, { deep: true, since: message.receivedAt }).skip === null,
      },
    };
  }

  /** Başvurunun kendisi ve yerine geçtiği önceki denemeler (en yeniden eskiye). */
  private async chainOf(attempt: ApplicationAttempt) {
    const chain: { sendMode: string; toEmail: string | null; retryOfId: string | null }[] = [attempt];
    const seen = new Set([attempt.id]);
    let parentId = attempt.retryOfId;
    while (parentId && !seen.has(parentId) && chain.length < 10) {
      seen.add(parentId);
      const parent = await this.prisma.applicationAttempt.findUnique({ where: { id: parentId }, select: { sendMode: true, toEmail: true, retryOfId: true } });
      if (!parent) break;
      chain.push(parent);
      parentId = parent.retryOfId;
    }
    return chain;
  }

  private async record(situation: Situation, result: Result, meta: { aiTasks: number; mode: 'auto' | 'approved'; actionId?: string; userId?: string | null }): Promise<AutopilotAction | null> {
    const data = {
      step: result.step,
      state: result.state,
      mode: meta.mode,
      detail: result.detail.slice(0, 1000),
      toEmail: result.toEmail ?? null,
      plan: ((result.state === 'executed' ? null : result.plan) ?? {}) as unknown as Prisma.InputJsonValue,
      resultAttemptId: result.state === 'executed' ? result.resultAttemptId : null,
      executedAt: result.state === 'executed' ? new Date() : null,
    };
    if (meta.actionId) return this.prisma.autopilotAction.update({ where: { id: meta.actionId }, data: { ...data, aiTasks: { increment: meta.aiTasks }, decidedById: meta.userId ?? null } });
    try {
      return await this.prisma.autopilotAction.create({
        data: { workspaceId: situation.attempt.workspaceId, companyId: situation.company.id, attemptId: situation.attempt.id, inboundMessageId: situation.message.id, category: situation.category, aiTasks: meta.aiTasks, ...data },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return null;
      throw e;
    }
  }

  private async announce(action: AutopilotAction, company: string) {
    const label = INBOUND_LABELS[action.category as InboundCategory] ?? action.category;
    const title = action.state === 'executed' ? `Otopilot: ${company} başvurusu yeniden gönderiliyor` : action.state === 'proposed' ? `Otopilot onayını bekliyor: ${company}` : `${company}: ${label.toLowerCase()}`;
    await this.outbox.emit({
      workspaceId: action.workspaceId,
      eventType: 'notify',
      aggregateId: action.id,
      dedupKey: `autopilot:${action.id}:${action.state}`,
      payload: { type: 'autopilot', title, body: action.state === 'info' || action.state === 'failed' ? action.detail : `${label}. ${action.detail}`, link: linkOf(action) },
    });
  }

  // ───────────── Kullanıcı işlemleri ─────────────

  /** Önerileri uygulanmak üzere sıraya alır; adres araması ve yazı düzeltmesi dakikalar sürebildiği için iş arka planda yürür. */
  async approve(workspaceId: string, userId: string, ids: string[]) {
    const actions = await this.prisma.autopilotAction.findMany({ where: { id: { in: ids }, workspaceId, state: 'proposed' }, select: { id: true } });
    for (const action of actions) {
      await this.prisma.autopilotAction.update({ where: { id: action.id }, data: { state: 'running', decidedById: userId } });
      await this.outbox.emit({ workspaceId, eventType: 'autopilot.run', aggregateId: action.id, dedupKey: `autopilot-run:${action.id}:${Date.now()}`, payload: { userId } });
    }
    return { queued: actions.length };
  }

  async dismiss(workspaceId: string, ids: string[]) {
    const r = await this.prisma.autopilotAction.updateMany({ where: { id: { in: ids }, workspaceId, state: 'proposed' }, data: { state: 'dismissed' } });
    return { dismissed: r.count };
  }

  /** Onaylanan öneriyi kullanıcının adına uygular: gönderim elle yapılmış sayılır ve hemen sıraya girer. */
  async runApproved(actionId: string, userId: string) {
    const action = await this.prisma.autopilotAction.findUnique({ where: { id: actionId } });
    if (!action || action.state !== 'running') return { status: 'skipped' as const };
    const message = await this.prisma.inboundMessage.findUnique({ where: { id: action.inboundMessageId } });
    const situation = message ? await this.situationOf(message) : null;
    if (!message || !situation || message.status !== 'open') {
      await this.prisma.autopilotAction.update({ where: { id: action.id }, data: { state: 'dismissed' } });
      return { status: 'skipped' as const };
    }
    const scope: AiClass = 'interactive';
    let run: { value: Result; calls: number };
    try {
      run = await withAiClass(scope, () => this.carryOut(action, situation, userId));
    } catch (e) {
      run = { value: { state: 'failed', step: action.step as AutopilotStep, detail: `Uygulanamadı: ${errorMessage(e)}` }, calls: 0 };
    }
    const updated = await this.record(situation, run.value, { aiTasks: run.calls, mode: 'approved', actionId: action.id, userId });
    return { status: 'done' as const, state: updated?.state };
  }

  private async carryOut(action: AutopilotAction, situation: Situation, userId: string): Promise<Result> {
    const by = { userId, auto: false, why: action.detail };
    const step = action.step as AutopilotStep;
    if (step === 'fix_format' || step === 'ai_review') return this.reviseAndSend(situation, userId, by);
    if (step === 'research') {
      const searched = await this.searchAddress(situation, userId);
      const toEmail = searched.situation.suggestedEmail ?? searched.situation.alternatives[0];
      if (!toEmail) return { state: 'info', step, detail: searched.ok ? 'Yapılan aramada firmanın kullanılabilir başka bir adresi bulunamadı. Firmanın diğer başvuru kanallarını kullanabilirsin.' : 'Yeni adres araması şu an yapılamadı; daha sonra yeniden deneyebilirsin.' };
      return this.send(searched.situation, { toEmail, attachments: 'all', delayDays: 0 }, { ...by, why: 'Yeni adres arandı ve bulunan adrese gönderildi.' });
    }
    const plan = action.plan as unknown as Partial<ResendPlan>;
    if (step !== 'resend' || !plan.toEmail) return { state: 'info', step, detail: action.detail };
    return this.send(situation, { toEmail: plan.toEmail, attachments: plan.attachments ?? 'all', delayDays: plan.delayDays ?? 0, subject: plan.subject, body: plan.body, generator: plan.generator }, by);
  }

  // ───────────── Görünürlük ─────────────

  async overview(workspaceId: string): Promise<ServerShape<AutopilotOverview>> {
    const actions = await this.prisma.autopilotAction.findMany({ where: { workspaceId, state: { not: 'dismissed' } }, orderBy: { createdAt: 'desc' }, take: LOG_LIMIT });
    const companies = await this.prisma.company.findMany({ where: { id: { in: [...new Set(actions.map((a) => a.companyId))] } }, select: { id: true, name: true } });
    const retries = await this.prisma.applicationAttempt.findMany({ where: { id: { in: actions.map((a) => a.resultAttemptId).filter((id): id is string => !!id) } }, select: { id: true, state: true, scheduledAt: true } });
    const nameOf = new Map(companies.map((c) => [c.id, c.name]));
    const retryOf = new Map(retries.map((r) => [r.id, r]));
    const items: ServerShape<AutopilotActionItem>[] = actions.map((a) => {
      const category = a.category as InboundCategory;
      const retry = a.resultAttemptId ? retryOf.get(a.resultAttemptId) : undefined;
      return {
        id: a.id,
        messageId: a.inboundMessageId,
        attemptId: a.attemptId,
        companyId: a.companyId,
        company: nameOf.get(a.companyId) ?? '-',
        category,
        label: INBOUND_LABELS[category] ?? a.category,
        step: a.step as AutopilotStep,
        state: a.state as AutopilotState,
        approved: a.mode === 'approved',
        toEmail: a.toEmail,
        detail: a.detail,
        aiTasks: a.aiTasks,
        usesAi: a.state === 'proposed' && needsAi(a.step as AutopilotStep),
        retry: retry ? { id: retry.id, state: retry.state, scheduledAt: retry.scheduledAt } : null,
        createdAt: a.createdAt,
        executedAt: a.executedAt,
      };
    });
    return { mode: await this.mode(workspaceId), pending: items.filter((i) => i.state === 'proposed').length, actions: items, pipeline: await this.pipeline(workspaceId) };
  }

  /** Zincirin her aşamasında kaç firma/başvuru olduğu: bulundu → adres var → yazı hazır → sırada → gönderildi → ulaştı → yanıt. */
  async pipeline(workspaceId: string): Promise<PipelineCounts> {
    const sendable = { some: { suppressed: false, kind: { in: SENDABLE_CONTACT_KINDS } } };
    const sent = { workspaceId, channel: 'email', state: { in: SENT_ONWARD_STATES } };
    const [companies, withAddress, searched, lettersReady, queued, sentCount, bounced, replied, delivered] = await Promise.all([
      this.prisma.company.count({ where: { workspaceId, excluded: false } }),
      this.prisma.company.count({ where: { workspaceId, excluded: false, contacts: sendable } }),
      this.prisma.company.findMany({ where: { workspaceId, excluded: false, contacts: { none: sendable.some }, lastResearchedAt: { not: null } }, select: { researchMeta: true } }),
      this.prisma.applicationDraft.count({ where: { workspaceId, status: { in: ['draft', 'needs_review'] }, opportunityId: { not: null } } }),
      this.prisma.applicationAttempt.count({ where: { workspaceId, state: { in: ['queued', 'sending'] } } }),
      this.prisma.applicationAttempt.count({ where: sent }),
      this.prisma.applicationAttempt.count({ where: { ...sent, state: 'bounced' } }),
      this.prisma.applicationAttempt.count({ where: { ...sent, state: { in: ['replied', 'outcome_recorded'] } } }),
      this.prisma.learningEvent.count({ where: { workspaceId, kind: 'send', outcome: { path: ['delivered'], equals: true } } }),
    ]);
    const noAddress = searched.filter((c) => !!(c.researchMeta as ResearchMeta | null)?.contactsSearchedAt).length;
    return { companies, withAddress, noAddress, lettersReady, queued, sent: sentCount, delivered, bounced, replied };
  }
}
