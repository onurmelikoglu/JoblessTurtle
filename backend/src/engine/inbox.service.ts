import { Injectable, Logger } from '@nestjs/common';
import { MailAccount, Prisma } from '@prisma/client';
import { AuditService } from '../common/audit.service';
import { AppError, errorMessage, notFound } from '../common/errors';
import { OutboxService } from '../common/outbox.service';
import { PrismaService } from '../common/prisma.service';
import { HomeInbox, InboxDetail } from '../contracts/home';
import { ServerShape } from '../contracts/wire';
import { canTransition } from '../domain/attempt-state';
import { classifyPublishedEmail, isValidEmail, RecipientDelivery, recipientScore, SENDABLE_CONTACT_KINDS } from '../domain/contacts';
import {
  analyzeBounce,
  classifyCompanyMail,
  DEAD_ADDRESS_CATEGORIES,
  extractSuggestions,
  INBOUND_GROUP,
  INBOUND_HINTS,
  INBOUND_LABELS,
  InboundCategory,
  isAutomated,
  isBounce,
  isFreeMailDomain,
  messageIdsIn,
  registrableDomain,
  RESENDABLE_CATEGORIES,
  stripQuoted,
  UNDELIVERED_CATEGORIES,
} from '../domain/inbound';
import { AddressBookService } from './address-book.service';
import { AiService } from './ai/ai.service';
import { AutomationService } from './automation.service';
import { DraftingService } from './drafting.service';
import { JobAlertsService } from './job-alerts.service';
import { LearnedModelsService } from './learned-models.service';
import { canReadInbox, FetchedMail, InboxAuthError, InboxEnvelope, InboxReader, MailboxCursor } from './mail/inbox';
import { SendingService } from './sending.service';

const CURSOR_KEY = (accountId: string, path: string) => `inbox:cursor:${accountId}:${path}`;
const RUNNING_KEY = (accountId: string) => `inbox:running:${accountId}`;
const LOOKBACK_DAYS = 60;
/** Hiç başvuru gönderilmemiş hesapta ilk taramada geriye dönük bakılan süre (yalnızca ilan bildirimleri için). */
const ALERT_LOOKBACK_DAYS = 7;
const RUNNING_STALE_MS = 15 * 60_000;
const BODY_LIMIT = 20_000;
const AI_TEXT_LIMIT = 3_000;
const AI_MIN_CONFIDENCE = 0.6;
const RESENT_STATES = ['queued', 'sending'];
const SENT_STATES = ['provider_accepted', 'submission_unknown', 'replied', 'bounced', 'outcome_recorded'];
const OPEN_ON_ARRIVAL = new Set(['failed', 'action', 'reply', 'review']);
const SUGGESTION_CATEGORIES: InboundCategory[] = ['address_changed', 'format_issue', 'unknown'];
const DOMAIN_MATCH_WINDOW_MS = 45 * 86_400_000;
/** Otopilotun karar verdiği dönüş grupları: iletilemeyenler, yönlendirmeler ve incelenmesi gerekenler. */
const AUTOPILOT_GROUPS = new Set(['failed', 'action', 'review']);
/** Kuralın kesin tanıdığı otomatik yanıtlar; içinde adres ya da bağlantı yoksa yapay zekâya sorulmaz. */
const SETTLED_BY_RULE: InboundCategory[] = ['auto_reply', 'out_of_office'];
const REPLY_NOTICE: Partial<Record<InboundCategory, string>> = { interview: 'interview', human_reply: 'human_reply', rejection: 'rejection' };

type SentAttempt = { id: string; workspaceId: string; companyId: string; toEmail: string | null; providerMessageId: string | null; acceptedAt: Date | null; createdAt: Date; state: string };

export interface ResendInput {
  toEmail: string;
  subject: string;
  body: string;
  documentIds?: string[];
  generator?: string;
}

export interface ResendOptions {
  /** autopilot: kullanıcıya sorulmadan yapılan düzeltme; yalnızca firmanın doğrulanmış, bilinen adresine gider ve acil durdurmaya uyar. */
  mode?: 'manual' | 'autopilot';
  scheduledAt?: Date | null;
}

@Injectable()
export class InboxService {
  private readonly logger = new Logger('Inbox');

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
    private readonly automation: AutomationService,
    private readonly drafting: DraftingService,
    private readonly sending: SendingService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly addressBook: AddressBookService,
    private readonly models: LearnedModelsService,
    private readonly jobAlerts: JobAlertsService,
  ) {}

  async syncableAccounts(workspaceId?: string) {
    const accounts = await this.prisma.mailAccount.findMany({ where: { inboxSyncEnabled: true, health: 'ok', ...(workspaceId ? { workspaceId } : {}) } });
    return accounts.filter(canReadInbox);
  }

  async isRunning(accountId: string) {
    const kv = await this.prisma.keyValue.findUnique({ where: { key: RUNNING_KEY(accountId) } });
    const at = (kv?.value as { at?: string } | null)?.at;
    return !!at && Date.now() - new Date(at).getTime() < RUNNING_STALE_MS;
  }

  private async setRunning(accountId: string, running: boolean) {
    const key = RUNNING_KEY(accountId);
    if (!running) return this.prisma.keyValue.deleteMany({ where: { key } });
    const value = { at: new Date().toISOString() };
    return this.prisma.keyValue.upsert({ where: { key }, create: { key, value }, update: { value } });
  }

  /**
   * Hesabın gelen kutusunu tarar. Yalnızca iki tür posta okunur: gönderilmiş başvurularla eşleşenler (saklanır) ve iş
   * sitelerinden gelen ilan bildirimleri (saklanmaz; içindeki ilanlar listeye eklenir).
   */
  async syncAccount(accountId: string) {
    const account = await this.prisma.mailAccount.findUnique({ where: { id: accountId } });
    if (!account || !account.inboxSyncEnabled || !canReadInbox(account)) return { skipped: true };
    const attempts: SentAttempt[] = await this.prisma.applicationAttempt.findMany({
      where: { mailAccountId: account.id, providerMessageId: { not: null } },
      select: { id: true, workspaceId: true, companyId: true, toEmail: true, providerMessageId: true, acceptedAt: true, createdAt: true, state: true },
      orderBy: { createdAt: 'asc' },
    });
    await this.setRunning(account.id, true);
    const index = buildIndex(account, attempts);
    const lookback = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000);
    const firstSent = attempts[0] ? (attempts[0].acceptedAt ?? attempts[0].createdAt) : null;
    const since = firstSent ? new Date(Math.max(lookback.getTime(), firstSent.getTime() - 86_400_000)) : new Date(Date.now() - ALERT_LOOKBACK_DAYS * 86_400_000);
    const stats = { scanned: 0, matched: 0, created: 0, problems: 0, alerts: 0, jobs: 0 };
    const reader = new InboxReader(account);
    try {
      await this.jobAlerts.retryPending(account).catch((e) => this.logger.warn(`Bekleyen ilan bildirimleri işlenemedi: ${errorMessage(e)}`));
      await reader.connect();
      for (const path of await reader.mailboxes()) {
        const cursor = await this.cursor(account.id, path);
        const result = await reader.scan(
          path,
          cursor,
          since,
          async (envelopes) => {
            stats.scanned += envelopes.length;
            return envelopes.filter((e) => index.relevant(e) || this.jobAlerts.fromJobSite(e)).map((e) => e.uid);
          },
          (mail) => this.handleMail(account, index, mail, path === 'INBOX' ? null : path, stats),
          (envelope) => this.jobAlerts.fromJobSite(envelope),
        );
        await this.saveCursor(account.id, result.path, { uidValidity: result.uidValidity, lastUid: result.lastUid });
      }
      await this.prisma.mailAccount.update({ where: { id: account.id }, data: { inboxSyncedAt: new Date(), inboxError: null } });
    } catch (e) {
      const message = e instanceof InboxAuthError ? e.message : `Gelen kutusu okunamadı: ${errorMessage(e)}`;
      this.logger.warn(`${account.accountEmail}: ${message}`);
      await this.prisma.mailAccount.update({ where: { id: account.id }, data: { inboxError: message.slice(0, 300) } });
      return { error: message, ...stats };
    } finally {
      await reader.close();
      await this.setRunning(account.id, false);
    }
    return stats;
  }

  /** İş sitesinden gelen posta ilan bildirimi olarak, diğerleri gönderilmiş başvurunun dönüşü olarak işlenir. */
  async handleMail(account: MailAccount, index: ReturnType<typeof buildIndex>, mail: FetchedMail, folder: string | null, stats: { matched: number; created: number; problems: number; alerts: number; jobs: number }) {
    if (this.jobAlerts.fromJobSite(mail)) {
      const result = await this.jobAlerts.ingest(account, mail).catch((e) => {
        this.logger.warn(`İlan bildirimi işlenemedi (${mail.subject.slice(0, 60)}): ${errorMessage(e)}`);
        return null;
      });
      if (result && result.status !== 'not_alert') stats.alerts++;
      stats.jobs += result?.fresh ?? 0;
      return;
    }
    const attempt = index.match(mail);
    if (!attempt) return;
    stats.matched++;
    const created = await this.store(account, attempt, mail, folder);
    if (created) {
      stats.created++;
      if (['failed', 'action'].includes(INBOUND_GROUP[created])) stats.problems++;
    }
  }

  private async cursor(accountId: string, path: string): Promise<MailboxCursor | null> {
    const kv = await this.prisma.keyValue.findUnique({ where: { key: CURSOR_KEY(accountId, path) } });
    return (kv?.value as unknown as MailboxCursor) ?? null;
  }

  private async saveCursor(accountId: string, path: string, cursor: MailboxCursor) {
    const key = CURSOR_KEY(accountId, path);
    const value = cursor as unknown as Prisma.InputJsonValue;
    await this.prisma.keyValue.upsert({ where: { key }, create: { key, value }, update: { value } });
  }

  /** Yeni kayıt oluşturulduysa kategorisini döndürür. */
  private async store(account: MailAccount, attempt: SentAttempt, mail: FetchedMail, folder: string | null): Promise<InboundCategory | null> {
    const providerMessageId = mail.messageId ?? `imap:${account.id}:${mail.date.getTime()}:${mail.subject.slice(0, 40)}`;
    const exists = await this.prisma.inboundMessage.findUnique({ where: { workspaceId_providerMessageId: { workspaceId: attempt.workspaceId, providerMessageId } } });
    if (exists) return null;
    const review = await this.review(attempt, mail);
    const group = INBOUND_GROUP[review.category];
    const body = review.bounce ? mail.text : stripQuoted(mail.text) || mail.text;
    let created: { id: string };
    try {
      created = await this.prisma.inboundMessage.create({
        select: { id: true },
        data: {
          workspaceId: attempt.workspaceId,
          mailAccountId: account.id,
          attemptId: attempt.id,
          providerMessageId,
          fromEmail: mail.fromEmail,
          subject: mail.subject.slice(0, 500),
          snippet: body.replace(/\s+/g, ' ').trim().slice(0, 300),
          bodyText: (folder ? `[${folder} klasöründe bulundu]\n\n` : '') + body.slice(0, BODY_LIMIT),
          classification: legacyClassification(review.category),
          category: review.category,
          reason: review.reason,
          failedRecipient: review.failedRecipient,
          suggestedEmail: review.suggestedEmail,
          suggestedUrl: review.suggestedUrl,
          status: OPEN_ON_ARRIVAL.has(group) ? 'open' : 'resolved',
          source: 'imap',
          receivedAt: mail.date,
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return null;
      throw e;
    }
    await this.applyEffects(attempt, review.category, review.suggestedEmail);
    const notice = REPLY_NOTICE[review.category];
    if (notice) {
      const company = await this.prisma.company.findUnique({ where: { id: attempt.companyId }, select: { name: true } });
      await this.outbox.emit({
        workspaceId: attempt.workspaceId,
        eventType: 'notify',
        aggregateId: attempt.id,
        dedupKey: `inbox-reply:${providerMessageId}`,
        payload: { type: notice, title: `${company?.name ?? 'Firma'}: ${INBOUND_LABELS[review.category].toLowerCase()}`, body: mail.subject, link: `/inbox?id=${created.id}` },
      });
    }
    if (AUTOPILOT_GROUPS.has(group)) {
      await this.outbox.emit({ workspaceId: attempt.workspaceId, eventType: 'autopilot.inbound', aggregateId: created.id, dedupKey: `autopilot:${created.id}`, payload: {} });
    }
    return review.category;
  }

  private async review(attempt: SentAttempt, mail: FetchedMail) {
    if (isBounce(mail)) {
      const info = analyzeBounce({ ...mail, text: `${mail.text}\n${mail.dsn}` });
      const detail = info.diagnostic ?? info.status;
      return {
        bounce: true,
        category: info.category,
        reason: detail ? `${INBOUND_LABELS[info.category]}: ${detail}` : INBOUND_LABELS[info.category],
        failedRecipient: info.failedRecipient ?? attempt.toEmail,
        suggestedEmail: null as string | null,
        suggestedUrl: null as string | null,
      };
    }
    const text = stripQuoted(mail.text) || mail.text;
    const ruleCategory = classifyCompanyMail({ ...mail, text });
    const exclude = [attempt.toEmail ?? '', mail.fromEmail ?? ''];
    const found = extractSuggestions(text, exclude);
    let category: InboundCategory = ruleCategory;
    let reason = '';
    let suggestedEmail = found.email;
    let suggestedUrl = found.url;
    const settledByRule = SETTLED_BY_RULE.includes(ruleCategory) && isAutomated(mail) && !found.email && !found.url;
    const r = settledByRule
      ? null
      : await this.ai
          .run({
            workspaceId: attempt.workspaceId,
            kind: 'inbound_review',
            input: { subject: mail.subject, text: text.slice(0, AI_TEXT_LIMIT), fromEmail: mail.fromEmail, sentTo: attempt.toEmail, ruleCategory },
            allowManual: false,
            entityType: 'ApplicationAttempt',
            entityId: attempt.id,
          })
          .catch(() => null);
    if (r?.status === 'succeeded') {
      const out = r.output as { category: InboundCategory; confidence: number; reason?: string; suggestedEmail?: string | null; suggestedUrl?: string | null };
      if (out.confidence >= AI_MIN_CONFIDENCE) category = out.category;
      reason = out.reason?.trim() ?? '';
      const lower = text.toLowerCase();
      if (out.suggestedEmail && isValidEmail(out.suggestedEmail) && lower.includes(out.suggestedEmail.toLowerCase()) && !exclude.includes(out.suggestedEmail.toLowerCase())) suggestedEmail = out.suggestedEmail.toLowerCase();
      if (out.suggestedUrl && text.includes(out.suggestedUrl)) suggestedUrl = out.suggestedUrl;
    }
    if (!SUGGESTION_CATEGORIES.includes(category)) suggestedEmail = null;
    return { bounce: false, category, reason: reason || INBOUND_LABELS[category], failedRecipient: null as string | null, suggestedEmail, suggestedUrl };
  }

  private async applyEffects(attempt: SentAttempt, category: InboundCategory, suggestedEmail: string | null) {
    const current = await this.prisma.applicationAttempt.findUnique({ where: { id: attempt.id } });
    if (!current) return;
    const next = UNDELIVERED_CATEGORIES.includes(category)
      ? 'bounced'
      : category === 'human_reply' || category === 'interview'
        ? 'replied'
        : category === 'rejection' || category === 'do_not_contact'
          ? 'outcome_recorded'
          : null;
    if (next && canTransition(current.state as never, next as never)) {
      await this.prisma.applicationAttempt.update({
        where: { id: current.id },
        data: {
          state: next,
          stateReason: next === 'bounced' ? `INBOUND:${category}` : current.stateReason,
          outcome: category === 'interview' ? 'interview' : category === 'rejection' ? 'rejection' : current.outcome,
        },
      });
    }
    if (next) await this.automation.cancelFollowUps(current.id, `Mail dönüşü: ${INBOUND_LABELS[category]}`);
    await this.addressBook.noteOutcome(current.id, category).catch((e) => this.logger.warn(`Adres sicili güncellenemedi (${current.id}): ${errorMessage(e)}`));
    if (DEAD_ADDRESS_CATEGORIES.includes(category) && current.toEmail) {
      await this.prisma.contactPoint.updateMany({ where: { companyId: current.companyId, email: current.toEmail }, data: { suppressed: true } });
    }
    if (category === 'do_not_contact') {
      await this.prisma.suppression.create({ data: { workspaceId: current.workspaceId, companyId: current.companyId, reason: 'Firma "iletişime geçmeyin" yanıtı verdi' } });
    }
    if (category === 'address_changed' && suggestedEmail) await this.rememberContact(current.workspaceId, current.companyId, suggestedEmail, 'source', 'Firmanın otomatik yanıtında bildirilen adres');
  }

  /** Geri dönmüş ya da geçersiz olduğu bilinen adres yeniden kullanıma açılmaz. */
  private async rememberContact(workspaceId: string, companyId: string, email: string, verifiedBy: 'source' | 'user', evidence: string) {
    const kind = classifyPublishedEmail(email).kind;
    const accepted = verifiedBy === 'user' ? [...SENDABLE_CONTACT_KINDS, 'other'] : ['official_hr', 'job_apply'];
    if (!accepted.includes(kind) || (await this.addressBook.isDead(email))) return;
    const sendableKind = SENDABLE_CONTACT_KINDS.includes(kind) ? kind : 'general';
    await this.prisma.contactPoint.upsert({
      where: { companyId_email: { companyId, email } },
      create: { workspaceId, companyId, email, kind: sendableKind, verifiedAt: new Date(), verifiedBy, ownershipEvidence: evidence, confidence: 'high' },
      update: { verifiedAt: new Date(), verifiedBy },
    });
    await this.addressBook.noteFound([{ email, foundBy: verifiedBy === 'user' ? 'user' : 'reply' }]);
  }

  // ───────────── Kullanıcı işlemleri ─────────────

  async list(workspaceId: string): Promise<ServerShape<HomeInbox>> {
    const accounts = await this.prisma.mailAccount.findMany({ where: { workspaceId }, select: { id: true, accountEmail: true, provider: true, smtpHost: true, encryptedSecret: true, inboxSyncEnabled: true, inboxSyncedAt: true, inboxError: true } });
    const messages = await this.prisma.inboundMessage.findMany({ where: { workspaceId, source: 'imap' }, orderBy: { receivedAt: 'desc' }, take: 500 });
    const attemptIds = [...new Set(messages.map((m) => m.attemptId).filter((x): x is string => !!x))];
    const attempts = await this.prisma.applicationAttempt.findMany({ where: { id: { in: attemptIds } }, select: { id: true, companyId: true, toEmail: true, state: true, acceptedAt: true, createdAt: true } });
    const retries = await this.prisma.applicationAttempt.findMany({ where: { retryOfId: { in: attemptIds } }, select: { id: true, retryOfId: true, state: true, toEmail: true }, orderBy: { createdAt: 'desc' } });
    const companies = await this.prisma.company.findMany({ where: { id: { in: attempts.map((a) => a.companyId) } }, select: { id: true, name: true, canonicalDomain: true, aliases: true, contacts: true } });
    const attemptById = new Map(attempts.map((a) => [a.id, a]));
    const companyById = new Map(companies.map((c) => [c.id, c]));
    const dead = await this.addressBook.deadAmong(messages.map((m) => m.suggestedEmail));
    const deliveryOf = new Map<string, RecipientDelivery | undefined>();
    for (const c of companies) deliveryOf.set(c.id, await this.models.deliveryFor(c));
    const items = messages.map((m) => {
      const attempt = m.attemptId ? attemptById.get(m.attemptId) : undefined;
      const company = attempt ? companyById.get(attempt.companyId) : undefined;
      const category = (m.category ?? 'unknown') as InboundCategory;
      const retry = retries.find((r) => r.retryOfId === m.attemptId);
      return {
        id: m.id,
        attemptId: m.attemptId,
        companyId: company?.id ?? null,
        company: company?.name ?? '-',
        toEmail: attempt?.toEmail ?? null,
        sentAt: attempt ? (attempt.acceptedAt ?? attempt.createdAt) : null,
        fromEmail: m.fromEmail,
        subject: m.subject,
        snippet: m.snippet,
        category,
        label: INBOUND_LABELS[category],
        group: INBOUND_GROUP[category],
        hint: INBOUND_HINTS[category] ?? null,
        reason: m.reason,
        suggestedEmail: m.suggestedEmail,
        suggestedUrl: m.suggestedUrl,
        status: m.status,
        receivedAt: m.receivedAt,
        canResend: RESENDABLE_CATEGORIES.includes(category) && !!m.attemptId,
        alternatives: company && attempt ? alternativeRecipients(company, attempt.toEmail, m.suggestedEmail && !dead.has(m.suggestedEmail) ? m.suggestedEmail : null, deliveryOf.get(company.id)) : [],
        retry: retry ? { id: retry.id, state: retry.state, toEmail: retry.toEmail } : null,
      };
    });
    const open = items.filter((i) => i.status === 'open');
    const running = await Promise.all(accounts.map((a) => this.isRunning(a.id)));
    return {
      alerts: await this.jobAlerts.stats(workspaceId),
      accounts: accounts.map((a, i) => ({
        id: a.id,
        email: a.accountEmail,
        supported: canReadInbox(a),
        enabled: a.inboxSyncEnabled,
        syncedAt: a.inboxSyncedAt,
        error: a.inboxError,
        running: running[i],
      })),
      counts: {
        open: open.length,
        failed: open.filter((i) => i.group === 'failed').length,
        action: open.filter((i) => i.group === 'action').length,
        reply: open.filter((i) => i.group === 'reply').length,
        review: open.filter((i) => i.group === 'review').length,
        delivered: items.filter((i) => i.group === 'delivered').length,
      },
      items,
    };
  }

  async detail(workspaceId: string, id: string): Promise<ServerShape<InboxDetail>> {
    const m = await this.prisma.inboundMessage.findFirst({ where: { id, workspaceId } });
    if (!m) throw notFound('Mail dönüşü');
    return { id: m.id, fromEmail: m.fromEmail, subject: m.subject, body: m.bodyText ?? m.snippet ?? '', receivedAt: m.receivedAt, reason: m.reason };
  }

  async setStatus(workspaceId: string, ids: string[], status: 'open' | 'resolved' | 'ignored') {
    const r = await this.prisma.inboundMessage.updateMany({ where: { id: { in: ids }, workspaceId }, data: { status, handledAt: status === 'open' ? null : new Date() } });
    if (status !== 'open') await this.prisma.autopilotAction.updateMany({ where: { workspaceId, inboundMessageId: { in: ids }, state: 'proposed' }, data: { state: 'dismissed' } });
    return { updated: r.count };
  }

  async setEnabled(workspaceId: string, enabled: boolean) {
    await this.prisma.mailAccount.updateMany({ where: { workspaceId }, data: { inboxSyncEnabled: enabled, ...(enabled ? { inboxError: null } : {}) } });
    return { enabled };
  }

  async requestSync(workspaceId: string) {
    const accounts = await this.syncableAccounts(workspaceId);
    const stamp = Date.now();
    for (const a of accounts) await this.outbox.emit({ workspaceId, eventType: 'inbox.sync', aggregateId: a.id, dedupKey: `inbox-sync:${a.id}:${stamp}`, payload: {} });
    return { queued: accounts.length };
  }

  /** Başvuruyu yeni bir taslak sürümüyle (düzenlenmiş alıcı, konu, metin) tekrar sıraya alır. */
  async resend(workspaceId: string, userId: string | null, attemptId: string, input: ResendInput, opts: ResendOptions = {}) {
    const mode = opts.mode ?? 'manual';
    const attempt = await this.prisma.applicationAttempt.findFirst({ where: { id: attemptId, workspaceId } });
    if (!attempt) throw notFound('Başvuru');
    if (!SENT_STATES.includes(attempt.state)) throw new AppError(409, 'NOT_RESENDABLE', 'Yalnızca gönderilmiş başvurular tekrar gönderilebilir');
    const pending = await this.prisma.applicationAttempt.findFirst({ where: { retryOfId: attempt.id, state: { in: RESENT_STATES } } });
    if (pending) throw new AppError(409, 'RESEND_PENDING', 'Bu başvurunun tekrar gönderimi zaten sırada');
    const toEmail = input.toEmail.trim().toLowerCase();
    if (!isValidEmail(toEmail)) throw new AppError(422, 'RECIPIENT_INVALID', 'Alıcı adresi geçersiz');
    const oldDraft = await this.prisma.applicationDraft.findUniqueOrThrow({ where: { id: attempt.draftId } });
    const oldRevision = await this.prisma.draftRevision.findUnique({ where: { draftId_revision: { draftId: oldDraft.id, revision: attempt.draftRevision } } });
    const contact = await this.prisma.contactPoint.findUnique({ where: { companyId_email: { companyId: attempt.companyId, email: toEmail } } });
    if (contact?.suppressed || (await this.addressBook.isDead(toEmail))) throw new AppError(422, 'SUPPRESSED', 'Bu adres daha önce geri döndü ve bir daha kullanılmıyor; başka bir adres seç');
    if (!contact && mode === 'manual') await this.rememberContact(workspaceId, attempt.companyId, toEmail, 'user', 'Tekrar gönderimde kullanıcı girdi');

    const draft = await this.prisma.applicationDraft.create({
      data: {
        workspaceId,
        candidateId: oldDraft.candidateId,
        opportunityId: oldDraft.opportunityId,
        companyId: oldDraft.companyId,
        jobId: oldDraft.jobId,
        intentType: oldDraft.intentType,
        mailAccountId: attempt.mailAccountId ?? oldDraft.mailAccountId,
        origin: mode === 'autopilot' ? 'automation' : 'manual',
        createdById: userId,
      },
    });
    await this.drafting.addRevision(
      draft,
      { toEmail, subject: input.subject.trim(), body: input.body.trim(), documentIds: await this.currentDocuments(oldDraft.candidateId, input.documentIds ?? oldRevision?.documentIds ?? []), links: oldRevision?.links ?? [] },
      { createdById: userId, generator: input.generator ?? 'user' },
    );
    const fresh = await this.prisma.applicationDraft.findUniqueOrThrow({ where: { id: draft.id } });
    const releasedKey = attempt.activeKey;
    if (releasedKey) await this.prisma.applicationAttempt.update({ where: { id: attempt.id }, data: { activeKey: null } });
    try {
      const { attempt: queued } = await this.sending.queueSend({
        workspaceId,
        userId,
        draftId: fresh.id,
        idempotencyKey: `resend:${attempt.id}:${fresh.currentRevision}:${Date.now()}`,
        expectedRevision: fresh.currentRevision,
        sendMode: mode,
        overrideCooldown: true,
        scheduledAt: opts.scheduledAt ?? null,
      });
      await this.prisma.applicationAttempt.update({ where: { id: queued.id }, data: { retryOfId: attempt.id } });
      await this.prisma.inboundMessage.updateMany({ where: { attemptId: attempt.id, status: 'open' }, data: { status: 'resent', resentAttemptId: queued.id, handledAt: new Date() } });
      if (mode === 'manual') await this.prisma.autopilotAction.updateMany({ where: { attemptId: attempt.id, state: 'proposed' }, data: { state: 'dismissed' } });
      await this.audit.log({ workspaceId, actorId: userId, actorType: userId ? 'user' : 'worker', action: 'application.resend', entityType: 'ApplicationAttempt', entityId: queued.id, next: { retryOf: attempt.id, toEmail, mode } });
      return { attemptId: queued.id, state: queued.state, toEmail, scheduledAt: queued.scheduledAt };
    } catch (e) {
      if (releasedKey) await this.prisma.applicationAttempt.updateMany({ where: { id: attempt.id, activeKey: null }, data: { activeKey: releasedKey } }).catch(() => undefined);
      await this.prisma.applicationDraft.update({ where: { id: draft.id }, data: { status: 'cancelled' } });
      throw e;
    }
  }

  /** Arşivlenmiş (yerine yenisi yüklenmiş) belge, aynı türün güncel sürümüyle değiştirilir. */
  async currentDocuments(candidateId: string, documentIds: string[]) {
    if (!documentIds.length) return [];
    const docs = await this.prisma.documentVersion.findMany({ where: { id: { in: documentIds }, candidateId } });
    const latest = await this.prisma.documentVersion.findMany({ where: { candidateId, archived: false, scanState: 'clean' }, orderBy: { createdAt: 'desc' } });
    const ids = docs.map((d) => (d.archived || d.scanState !== 'clean' ? latest.find((l) => l.type === d.type)?.id : d.id)).filter((x): x is string => !!x);
    return [...new Set(ids)];
  }

  /** Aynı içerikle toplu tekrar gönderim; geçersiz adreste firmanın sıradaki uygun adresi kullanılır. */
  async resendMany(workspaceId: string, userId: string | null, attemptIds: string[]) {
    const results: { attemptId: string; company: string; status: 'queued' | 'skipped'; toEmail?: string; reason?: string }[] = [];
    for (const attemptId of attemptIds) {
      const attempt = await this.prisma.applicationAttempt.findFirst({ where: { id: attemptId, workspaceId } });
      if (!attempt) continue;
      const company = await this.prisma.company.findUnique({ where: { id: attempt.companyId }, select: { name: true, canonicalDomain: true, aliases: true, contacts: true } });
      const name = company?.name ?? '-';
      const message = await this.prisma.inboundMessage.findFirst({ where: { attemptId: attempt.id }, orderBy: { receivedAt: 'desc' } });
      const category = (message?.category ?? 'unknown') as InboundCategory;
      if (category === 'apply_elsewhere') {
        results.push({ attemptId, company: name, status: 'skipped', reason: 'Firma başka kanaldan başvuru istiyor' });
        continue;
      }
      if (category === 'format_issue') {
        results.push({ attemptId, company: name, status: 'skipped', reason: 'Firmanın istediği biçime göre tek tek düzenlenmeli' });
        continue;
      }
      const sameAddressOk = !DEAD_ADDRESS_CATEGORIES.includes(category) && !company?.contacts.some((c) => c.email === attempt.toEmail && c.suppressed);
      const suggestedEmail = (await this.addressBook.isDead(message?.suggestedEmail)) ? null : (message?.suggestedEmail ?? null);
      const toEmail = sameAddressOk ? attempt.toEmail : (company ? alternativeRecipients(company, attempt.toEmail, suggestedEmail, await this.models.deliveryFor(company))[0]?.email : undefined);
      if (!toEmail) {
        results.push({ attemptId, company: name, status: 'skipped', reason: 'Firmanın başka geçerli adresi yok' });
        continue;
      }
      const revision = await this.prisma.draftRevision.findUnique({ where: { draftId_revision: { draftId: attempt.draftId, revision: attempt.draftRevision } } });
      if (!revision) {
        results.push({ attemptId, company: name, status: 'skipped', reason: 'Önceki mail içeriği bulunamadı' });
        continue;
      }
      try {
        const r = await this.resend(workspaceId, userId, attemptId, { toEmail, subject: revision.subject, body: revision.body, documentIds: revision.documentIds });
        results.push({ attemptId, company: name, status: 'queued', toEmail: r.toEmail });
      } catch (e) {
        results.push({ attemptId, company: name, status: 'skipped', reason: errorMessage(e) });
      }
    }
    return { queued: results.filter((r) => r.status === 'queued').length, results };
  }
}

/** Bülten ve kampanya mailleri: başvuruya yanıt sayılmaz (yanıt zinciri eşleşmesi hariç). */
function isBulkMail(headers: Record<string, string>) {
  return !!headers['list'] || !!headers['list-unsubscribe'] || !!headers['list-id'] || /^(bulk|list|junk)$/i.test((headers['precedence'] ?? '').trim());
}

function legacyClassification(category: InboundCategory) {
  if (UNDELIVERED_CATEGORIES.includes(category) && !['format_issue', 'apply_elsewhere', 'address_changed'].includes(category)) return 'bounce';
  if (['auto_reply', 'out_of_office', 'format_issue', 'apply_elsewhere', 'address_changed', 'delayed'].includes(category)) return 'autoresponder';
  if (['human_reply', 'interview', 'rejection', 'do_not_contact'].includes(category)) return category;
  return 'unknown';
}

export function alternativeRecipients(
  company: { canonicalDomain: string | null; aliases: string[]; contacts: { email: string; kind: string; suppressed: boolean; sourceUrl?: string | null; verifiedAt?: Date | null; verifiedBy?: string | null }[] },
  failedEmail: string | null,
  suggestedEmail: string | null,
  delivery?: RecipientDelivery,
) {
  const scoring = { domain: company.canonicalDomain, aliases: company.aliases, delivery };
  const options = company.contacts
    .filter((c) => !c.suppressed && SENDABLE_CONTACT_KINDS.includes(c.kind) && isValidEmail(c.email) && c.email !== failedEmail)
    .sort((a, b) => recipientScore(b, scoring) - recipientScore(a, scoring))
    .map((c) => ({ email: c.email.toLowerCase(), source: 'contact' as const }));
  const suggested = suggestedEmail && suggestedEmail !== failedEmail ? [{ email: suggestedEmail, source: 'reply' as const }] : [];
  const seen = new Set<string>();
  return [...suggested, ...options].filter((o) => !seen.has(o.email) && seen.add(o.email)).slice(0, 6);
}

/** Gönderilmiş başvurular üzerinden hangi gelen maillerin ilgili olduğunu ve hangi başvuruya ait olduğunu bulur. */
export function buildIndex(account: Pick<MailAccount, 'accountEmail'>, attempts: SentAttempt[]) {
  const own = account.accountEmail.toLowerCase();
  const byMessageId = new Map<string, SentAttempt>();
  const byEmail = new Map<string, SentAttempt[]>();
  const byDomain = new Map<string, SentAttempt[]>();
  for (const a of attempts) {
    if (a.providerMessageId) byMessageId.set(a.providerMessageId.toLowerCase(), a);
    if (!a.toEmail) continue;
    const email = a.toEmail.toLowerCase();
    byEmail.set(email, [...(byEmail.get(email) ?? []), a]);
    const domain = registrableDomain(email);
    if (!isFreeMailDomain(domain)) byDomain.set(domain, [...(byDomain.get(domain) ?? []), a]);
  }
  const latestBefore = (list: SentAttempt[] | undefined, date: Date, windowMs = Number.POSITIVE_INFINITY) => {
    const sent = (list ?? []).filter((a) => {
      const at = (a.acceptedAt ?? a.createdAt).getTime();
      return at <= date.getTime() + 60_000 && date.getTime() - at <= windowMs;
    });
    return sent[sent.length - 1] ?? null;
  };
  const bounceSender = (e: Pick<InboxEnvelope, 'fromEmail' | 'fromName' | 'subject'>) => isBounce({ fromEmail: e.fromEmail, fromName: e.fromName, subject: e.subject, text: '', headers: {}, contentType: null });
  return {
    relevant(e: InboxEnvelope) {
      if (!e.fromEmail || e.fromEmail === own) return false;
      if (e.inReplyTo && byMessageId.has(e.inReplyTo)) return true;
      if (bounceSender(e)) return true;
      if (byEmail.has(e.fromEmail)) return true;
      return byDomain.has(registrableDomain(e.fromEmail));
    },
    match(mail: FetchedMail): SentAttempt | null {
      for (const id of messageIdsIn(mail.raw)) {
        const hit = byMessageId.get(id);
        if (hit) return hit;
      }
      if (isBounce(mail)) {
        const info = analyzeBounce({ ...mail, text: `${mail.text}\n${mail.dsn}` });
        if (info.failedRecipient) return latestBefore(byEmail.get(info.failedRecipient), mail.date);
        for (const [email, list] of byEmail) if (mail.text.toLowerCase().includes(email)) return latestBefore(list, mail.date);
        return null;
      }
      if (!mail.fromEmail || isBulkMail(mail.headers)) return null;
      return latestBefore(byEmail.get(mail.fromEmail), mail.date, DOMAIN_MATCH_WINDOW_MS) ?? latestBefore(byDomain.get(registrableDomain(mail.fromEmail)), mail.date, DOMAIN_MATCH_WINDOW_MS);
    },
  };
}
