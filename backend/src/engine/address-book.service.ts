import { Injectable, Logger } from '@nestjs/common';
import { ApplicationAttempt, LearningEvent, Prisma } from '@prisma/client';
import { errorMessage } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { istanbulNow } from '../common/time';
import { addressFeatures, addressSourceType, DeliveryEffect, deliveryEffectOf, emailDomain, NO_BOUNCE_SETTLE_HOURS, strongestEffect, UNOBSERVED_AFTER_DAYS } from '../domain/address-book';
import { isValidEmail, SENDABLE_CONTACT_KINDS } from '../domain/contacts';
import { isFreeMailDomain, registrableDomain } from '../domain/inbound';
import { NO_BOUNCE_OUTCOME, SendOutcome, UNOBSERVED_OUTCOME } from '../domain/learning';
import { LearnedModelsService } from './learned-models.service';
import { canReadInbox } from './mail/inbox';

const SEND_KIND = 'send';
const DELIVERY_VERIFIED_BY = 'delivery';
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const SETTLE_SCAN_LIMIT = 5000;
const MAX_AVOIDED_ADDRESSES = 30;
const STATE_EFFECTS: Record<string, { category: string; effect: DeliveryEffect }> = {
  replied: { category: 'human_reply', effect: { delivered: true, bounced: false, replied: true, dead: null } },
  outcome_recorded: { category: 'human_reply', effect: { delivered: true, bounced: false, replied: true, dead: null } },
  bounced: { category: 'bounce_other', effect: { delivered: false, bounced: true, replied: false, dead: null } },
};
const ASSUMED_DELIVERY: DeliveryEffect = { delivered: true, bounced: false, replied: false, dead: null };

const OUTCOME_FIELDS = { id: true, attemptId: true, outcome: true, resolvedAt: true, createdAt: true } satisfies Prisma.LearningEventSelect;
type SendEvent = Pick<LearningEvent, keyof typeof OUTCOME_FIELDS>;

export interface FoundAddress {
  email: string;
  sourceUrl?: string | null;
  foundBy?: string | null;
}

/**
 * Adres sicili: her e-posta adresinin gönderim geçmişi çalışma alanlarından bağımsız tutulur. Kesin olarak geçersiz
 * olduğu öğrenilen adres hiçbir çalışma alanında yeniden seçilemez; ulaştığı görülen adres doğrulanmış sayılır.
 */
@Injectable()
export class AddressBookService {
  private readonly logger = new Logger('AddressBook');

  constructor(
    private readonly prisma: PrismaService,
    private readonly models: LearnedModelsService,
  ) {}

  async deadAmong(emails: (string | null | undefined)[]): Promise<Set<string>> {
    const list = [...new Set(emails.map((e) => e?.trim().toLowerCase()).filter((e): e is string => !!e))];
    if (!list.length) return new Set();
    const domains = [...new Set(list.map(emailDomain).filter((d): d is string => !!d))];
    const [records, deadDomains] = await Promise.all([
      this.prisma.addressRecord.findMany({ where: { email: { in: list }, status: 'dead' }, select: { email: true } }),
      this.prisma.deadDomain.findMany({ where: { domain: { in: domains } }, select: { domain: true } }),
    ]);
    const dead = new Set(records.map((r) => r.email));
    const deadDomainNames = new Set(deadDomains.map((d) => d.domain));
    for (const email of list) if (deadDomainNames.has(emailDomain(email) ?? '')) dead.add(email);
    return dead;
  }

  async isDead(email: string | null | undefined) {
    return !!email && (await this.deadAmong([email])).has(email.trim().toLowerCase());
  }

  /** Yeni adres aramasında "bunların dışındakileri ara" diye verilen adresler: firmanın geri dönen ve geçersiz bilinen adresleri. */
  async avoidedForCompany(companyId: string): Promise<string[]> {
    const company = await this.prisma.company.findUnique({ where: { id: companyId }, select: { canonicalDomain: true, contacts: { select: { email: true, suppressed: true } } } });
    if (!company) return [];
    const onDomain = company.canonicalDomain
      ? await this.prisma.addressRecord.findMany({
          where: { status: 'dead', OR: [{ domain: company.canonicalDomain }, { domain: { endsWith: `.${company.canonicalDomain}` } }] },
          select: { email: true },
          orderBy: { deadAt: 'desc' },
          take: MAX_AVOIDED_ADDRESSES,
        })
      : [];
    const knownDead = await this.deadAmong(company.contacts.map((c) => c.email));
    const suppressed = company.contacts.filter((c) => c.suppressed).map((c) => c.email);
    return [...new Set([...suppressed, ...knownDead, ...onDomain.map((r) => r.email)])].slice(0, MAX_AVOIDED_ADDRESSES);
  }

  /** Bulunan adresi ilk görüldüğü kaynakla kaydeder; var olan kayda dokunmaz. */
  async noteFound(entries: FoundAddress[], company?: { canonicalDomain: string | null; aliases?: string[] }) {
    const data = entries
      .map((e) => ({ ...e, email: e.email.trim().toLowerCase() }))
      .filter((e) => isValidEmail(e.email) && emailDomain(e.email))
      .map((e) => ({
        email: e.email,
        domain: emailDomain(e.email)!,
        sourceUrl: e.sourceUrl ?? null,
        sourceType: addressSourceType(e.sourceUrl, company?.canonicalDomain, company?.aliases ?? []),
        foundBy: e.foundBy ?? null,
      }));
    if (data.length) await this.prisma.addressRecord.createMany({ data, skipDuplicates: true });
  }

  /** Firmanın adreslerini sicille eşitler: geçersizler kapatılır, ulaştığı bilinenler doğrulanmış sayılır. */
  async syncContacts(companyId: string) {
    const contacts = await this.prisma.contactPoint.findMany({ where: { companyId }, select: { id: true, email: true, kind: true, suppressed: true, verifiedAt: true } });
    if (!contacts.length) return;
    const emails = contacts.map((c) => c.email);
    const [dead, deliverable] = await Promise.all([
      this.deadAmong(emails),
      this.prisma.addressRecord.findMany({ where: { email: { in: emails }, status: 'deliverable' }, select: { email: true } }),
    ]);
    const reached = new Set(deliverable.map((r) => r.email));
    const toSuppress = contacts.filter((c) => !c.suppressed && dead.has(c.email)).map((c) => c.id);
    const toVerify = contacts.filter((c) => !c.suppressed && !c.verifiedAt && !dead.has(c.email) && reached.has(c.email) && SENDABLE_CONTACT_KINDS.includes(c.kind)).map((c) => c.id);
    if (toSuppress.length) await this.prisma.contactPoint.updateMany({ where: { id: { in: toSuppress } }, data: { suppressed: true } });
    if (toVerify.length) await this.prisma.contactPoint.updateMany({ where: { id: { in: toVerify } }, data: { verifiedAt: new Date(), verifiedBy: DELIVERY_VERIFIED_BY } });
  }

  /** Sağlayıcının kabul ettiği gönderimi sicile ve deneyim defterine işler. Aynı başvuru ikinci kez sayılmaz. */
  async noteSent(attemptId: string): Promise<LearningEvent | null> {
    const attempt = await this.prisma.applicationAttempt.findUnique({ where: { id: attemptId } });
    if (!attempt?.toEmail || attempt.channel !== 'email') return null;
    const existing = await this.prisma.learningEvent.findUnique({ where: { kind_attemptId: { kind: SEND_KIND, attemptId } } });
    if (existing) return existing;
    const email = attempt.toEmail.toLowerCase();
    const sentAt = attempt.acceptedAt ?? attempt.createdAt;
    const { features, catalogCompanyId, sourceUrl, company } = await this.sendFeatures(attempt, email, sentAt);
    let event: LearningEvent;
    try {
      event = await this.prisma.learningEvent.create({
        data: { workspaceId: attempt.workspaceId, kind: SEND_KIND, companyId: attempt.companyId, catalogCompanyId, attemptId, features: features as Prisma.InputJsonValue, createdAt: sentAt },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return this.prisma.learningEvent.findUnique({ where: { kind_attemptId: { kind: SEND_KIND, attemptId } } });
      throw e;
    }
    const domain = emailDomain(email);
    if (!domain) return event;
    await this.prisma.addressRecord.upsert({
      where: { email },
      create: { email, domain, sourceUrl, sourceType: addressSourceType(sourceUrl, company?.canonicalDomain, company?.aliases ?? []), sent: 1, lastSentAt: sentAt },
      update: { sent: { increment: 1 }, lastSentAt: sentAt },
    });
    return event;
  }

  private async sendFeatures(attempt: ApplicationAttempt, email: string, sentAt: Date) {
    const [company, contact, draft, revision] = await Promise.all([
      this.prisma.company.findUnique({ where: { id: attempt.companyId }, select: { canonicalDomain: true, aliases: true, employeeRange: true, origin: true, catalogId: true } }),
      this.prisma.contactPoint.findUnique({ where: { companyId_email: { companyId: attempt.companyId, email } }, select: { email: true, kind: true, sourceUrl: true, verifiedAt: true, verifiedBy: true } }),
      this.prisma.applicationDraft.findUnique({ where: { id: attempt.draftId }, select: { opportunityId: true } }),
      this.prisma.draftRevision.findUnique({ where: { draftId_revision: { draftId: attempt.draftId, revision: attempt.draftRevision } }, select: { generator: true, documentIds: true, body: true } }),
    ]);
    const opportunity = draft?.opportunityId ? await this.prisma.opportunity.findUnique({ where: { id: draft.opportunityId }, select: { category: true, titleMatch: true, f: true } }) : null;
    const at = istanbulNow(sentAt);
    const delivery = company && contact ? await this.models.deliveryFor(company) : undefined;
    const features = {
      ...addressFeatures({ email, kind: contact?.kind ?? 'unlisted', sourceUrl: contact?.sourceUrl, verified: !!contact?.verifiedAt }, { canonicalDomain: company?.canonicalDomain ?? null, aliases: company?.aliases }),
      verifiedBy: contact?.verifiedBy ?? null,
      intent: attempt.intentType,
      sendMode: attempt.sendMode,
      hasJob: !!attempt.jobId,
      retry: !!attempt.retryOfId,
      category: opportunity?.category ?? null,
      titleMatch: opportunity?.titleMatch ?? null,
      fit: opportunity?.f ?? null,
      employeeRange: company?.employeeRange ?? null,
      companyOrigin: company?.origin ?? null,
      generator: revision?.generator ?? null,
      attachments: revision?.documentIds.length ?? 0,
      bodyLength: revision?.body.length ?? 0,
      hour: at.hour,
      weekday: at.weekday,
      pDeliver: delivery && contact ? Math.round(delivery.of(contact) * 1000) / 1000 : null,
    };
    return { features, catalogCompanyId: company?.catalogId ?? null, sourceUrl: contact?.sourceUrl ?? null, company };
  }

  /** Mail dönüşünü adres siciline ve gönderimin deneyim kaydına işler. Aynı başvuruda her etki bir kez sayılır. */
  async noteOutcome(attemptId: string, category: string | null | undefined) {
    const effect = deliveryEffectOf(category);
    if (!effect || !category) return;
    const event = await this.noteSent(attemptId);
    if (event) await this.applyOutcome(event, category, effect);
  }

  private async applyOutcome(event: SendEvent, category: string, effect: DeliveryEffect) {
    const attempt = event.attemptId ? await this.prisma.applicationAttempt.findUnique({ where: { id: event.attemptId }, select: { toEmail: true } }) : null;
    const email = attempt?.toEmail?.toLowerCase();
    if (!email) return;
    const previous = event.outcome as SendOutcome | null;
    const assumedDeliveryRefuted = effect.bounced && previous?.category === NO_BOUNCE_OUTCOME;
    const wasDelivered = !!previous?.delivered && !assumedDeliveryRefuted;
    const outcome: SendOutcome = {
      category: strongestEffect([assumedDeliveryRefuted ? null : previous?.category, category])?.category ?? category,
      delivered: wasDelivered || effect.delivered,
      bounced: !!previous?.bounced || effect.bounced,
      replied: !!previous?.replied || effect.replied,
      dead: !!previous?.dead || !!effect.dead,
    };
    await this.prisma.learningEvent.update({ where: { id: event.id }, data: { outcome: outcome as unknown as Prisma.InputJsonValue, resolvedAt: event.resolvedAt ?? new Date() } });
    const domain = emailDomain(email);
    if (!domain) return;
    const delivered = (outcome.delivered && !previous?.delivered ? 1 : 0) - (assumedDeliveryRefuted ? 1 : 0);
    const counters = {
      delivered: { increment: delivered },
      bounced: { increment: outcome.bounced && !previous?.bounced ? 1 : 0 },
      replied: { increment: outcome.replied && !previous?.replied ? 1 : 0 },
      lastOutcomeAt: new Date(),
    };
    const record = await this.prisma.addressRecord.upsert({
      where: { email },
      create: { email, domain, delivered: Math.max(delivered, 0), bounced: outcome.bounced ? 1 : 0, replied: outcome.replied ? 1 : 0, lastOutcomeAt: new Date() },
      update: counters,
    });
    if (effect.dead === 'domain') await this.markDomainDead(domain, email, category);
    else if (effect.dead === 'address') await this.markDead(email, category);
    else if (record.status !== 'dead') await this.refreshStatus(email, record.delivered);
  }

  private async refreshStatus(email: string, delivered: number) {
    const status = delivered > 0 ? 'deliverable' : 'unknown';
    await this.prisma.addressRecord.updateMany({ where: { email, status: { notIn: ['dead', status] } }, data: { status } });
    if (status !== 'deliverable') return;
    await this.prisma.contactPoint.updateMany({
      where: { email, suppressed: false, verifiedAt: null, kind: { in: SENDABLE_CONTACT_KINDS } },
      data: { verifiedAt: new Date(), verifiedBy: DELIVERY_VERIFIED_BY },
    });
  }

  /** Adres kalıcı olarak geçersiz: tüm çalışma alanlarında kapatılır, ilanlardaki başvuru adresi olarak da kullanılmaz. */
  async markDead(email: string, reason: string) {
    const address = email.trim().toLowerCase();
    const domain = emailDomain(address);
    if (!domain) return;
    await this.prisma.addressRecord.upsert({
      where: { email: address },
      create: { email: address, domain, status: 'dead', deadReason: reason, deadAt: new Date() },
      update: { status: 'dead' },
    });
    await this.prisma.addressRecord.updateMany({ where: { email: address, deadAt: null }, data: { deadReason: reason, deadAt: new Date() } });
    await this.prisma.contactPoint.updateMany({ where: { email: address, suppressed: false }, data: { suppressed: true } });
    await this.prisma.job.updateMany({ where: { applyEmail: { equals: address, mode: 'insensitive' } }, data: { applyEmail: null } });
  }

  /**
   * Alan adı mail almıyor. Ücretsiz posta sağlayıcıları ve daha önce mail ulaştığı görülen alan adları tek bir
   * bildirimle topluca kapatılmaz; bu durumda yalnızca adres geçersiz sayılır.
   */
  async markDomainDead(domain: string, email: string, reason: string) {
    await this.markDead(email, reason);
    if (isFreeMailDomain(registrableDomain(domain))) return;
    const proven = await this.prisma.addressRecord.count({ where: { domain, OR: [{ delivered: { gt: 0 } }, { replied: { gt: 0 } }] } });
    if (proven) return;
    await this.prisma.deadDomain.upsert({ where: { domain }, create: { domain, reason }, update: {} });
    await this.prisma.addressRecord.updateMany({ where: { domain, status: { not: 'dead' } }, data: { status: 'dead', deadReason: reason, deadAt: new Date() } });
    await this.prisma.contactPoint.updateMany({ where: { email: { endsWith: `@${domain}` }, suppressed: false }, data: { suppressed: true } });
    await this.prisma.job.updateMany({ where: { applyEmail: { endsWith: `@${domain}`, mode: 'insensitive' } }, data: { applyEmail: null } });
    this.logger.log(`Alan adı mail almıyor olarak işaretlendi: ${domain}`);
  }

  /**
   * Sonucu henüz bilinmeyen gönderimleri kapatır: gelen kutusu izlenen hesapta süre içinde geri dönmeyen mail ulaşmış
   * sayılır; gelen kutusu izlenemiyorsa sonuç "gözlenemedi" olarak kalır ve sicile işlenmez.
   */
  async settle(now = new Date()) {
    const events = await this.prisma.learningEvent.findMany({
      where: { kind: SEND_KIND, resolvedAt: null, createdAt: { lt: new Date(now.getTime() - NO_BOUNCE_SETTLE_HOURS * HOUR_MS) } },
      orderBy: { createdAt: 'asc' },
      take: SETTLE_SCAN_LIMIT,
      select: OUTCOME_FIELDS,
    });
    if (!events.length) return { settled: 0 };
    const attempts = await this.prisma.applicationAttempt.findMany({ where: { id: { in: events.map((e) => e.attemptId).filter((id): id is string => !!id) } }, select: { id: true, state: true, mailAccountId: true } });
    const accounts = await this.prisma.mailAccount.findMany({ where: { id: { in: attempts.map((a) => a.mailAccountId).filter((id): id is string => !!id) } } });
    const attemptById = new Map(attempts.map((a) => [a.id, a]));
    const accountById = new Map(accounts.map((a) => [a.id, a]));
    let settled = 0;
    for (const event of events) {
      try {
        const attempt = event.attemptId ? attemptById.get(event.attemptId) : undefined;
        const account = attempt?.mailAccountId ? accountById.get(attempt.mailAccountId) : undefined;
        const settledAt = event.createdAt.getTime() + NO_BOUNCE_SETTLE_HOURS * HOUR_MS;
        const inboxWatched = !!account && canReadInbox(account) && account.inboxSyncEnabled && !account.inboxError && (account.inboxSyncedAt?.getTime() ?? 0) >= settledAt;
        const byState = attempt ? STATE_EFFECTS[attempt.state] : undefined;
        if (byState) await this.applyOutcome(event, byState.category, byState.effect);
        else if (attempt?.state === 'provider_accepted' && inboxWatched) await this.applyOutcome(event, NO_BOUNCE_OUTCOME, ASSUMED_DELIVERY);
        else if (!attempt || now.getTime() - event.createdAt.getTime() > UNOBSERVED_AFTER_DAYS * DAY_MS) await this.closeUnobserved(event);
        else continue;
        settled++;
      } catch (e) {
        this.logger.warn(`Gönderim sonucu işlenemedi (${event.id}): ${errorMessage(e)}`);
      }
    }
    return { settled };
  }

  private closeUnobserved(event: SendEvent) {
    const outcome: SendOutcome = { category: UNOBSERVED_OUTCOME, delivered: false, bounced: false, replied: false, dead: false };
    return this.prisma.learningEvent.update({ where: { id: event.id }, data: { outcome: outcome as unknown as Prisma.InputJsonValue, resolvedAt: new Date() } });
  }
}
