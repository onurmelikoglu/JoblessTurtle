import { Injectable } from '@nestjs/common';
import { ApplicationDraft, CandidateProfile, Company, ContactPoint, Job, Prisma } from '@prisma/client';
import { hashObject } from '../common/crypto';
import { AppError, notFound } from '../common/errors';
import { OutboxService } from '../common/outbox.service';
import { PrismaService, Tx } from '../common/prisma.service';
import { isValidEmail, RecipientScoring, recipientScore, SENDABLE_CONTACT_KINDS } from '../domain/contacts';
import { ApplicationLanguage, applicationLanguageOf, ENGLISH_CV_MISSING, englishCvMissing, LanguageDecision, textLanguage } from '../domain/application-language';
import { attachmentsFor, attachmentsInLanguage, PRIMARY_LANGUAGE } from '../domain/documents';
import { replaceAdWord } from '../domain/text';
import { buildSignature, checkDraftContent, INTENT_LABELS, IntentType } from '../domain/templates';
import { AiService } from './ai/ai.service';
import { LearnedModelsService } from './learned-models.service';
import { isLetterIntent, LetterService } from './letter.service';

export interface DraftContent {
  toEmail: string | null;
  subject: string;
  body: string;
  documentIds: string[];
  links: string[];
}

export function draftHash(c: DraftContent) {
  return hashObject({ to: (c.toEmail ?? '').toLowerCase(), s: c.subject, b: c.body, d: [...c.documentIds].sort(), l: c.links });
}

/** Alıcı seçimi: puanı en yüksek gönderilebilir adres (ilanın başvuru adresi, İK, işe alım, genel). Tahmin ve grup adresi seçilmez. */
export function pickContact(contacts: ContactPoint[], opts: RecipientScoring = {}): ContactPoint | null {
  const usable = contacts.filter((c) => !c.suppressed && SENDABLE_CONTACT_KINDS.includes(c.kind) && isValidEmail(c.email));
  return usable.sort((a, b) => recipientScore(b, opts) - recipientScore(a, opts))[0] ?? null;
}

export function intentForCategory(category: string): IntentType {
  if (category === 'target_open' || category === 'adjacent_open' || category === 'user_selected') return 'job_application';
  if (category === 'past_closed') return 'intent_after_closed';
  return 'general_intent';
}

const SUBJECT_WORDS: Record<ApplicationLanguage, { job: string; open: string }> = { tr: { job: 'İş Başvurusu', open: 'Açık Başvuru' }, en: { job: 'Job Application', open: 'Open Application' } };

export function applicationSubject(intent: IntentType, jobTitle: string | null, candidate: { displayName: string; headline?: string | null }, language: ApplicationLanguage = 'tr') {
  const words = SUBJECT_WORDS[language];
  if (intent === 'job_application' && jobTitle) return `${words.job}: ${jobTitle} – ${candidate.displayName}`;
  return candidate.headline ? `${words.open}: ${candidate.headline} – ${candidate.displayName}` : `${words.open} – ${candidate.displayName}`;
}

export const ENGLISH_TRANSLATION_FAILED = 'İngilizce çeviri yapılamadı: yazı Türkçe kaldı; yabancı firmaya göndermeden önce çevir.';

type LanguageCompany = Pick<Company, 'applicationLanguage' | 'canonicalDomain' | 'researchMeta'> & { offices: { city: string | null; district: string | null; address: string | null }[] };
type LanguageJob = Pick<Job, 'title' | 'description' | 'locationText' | 'workMode'>;

/** Firmaya ve (varsa) ilana göre başvurunun dili; ilan yoksa yalnız firma bilgisine bakılır. */
export function languageForApplication(company: LanguageCompany, job: LanguageJob | null): LanguageDecision {
  const meta = (company.researchMeta ?? {}) as { siteLanguage?: string | null };
  return applicationLanguageOf({
    companyChoice: company.applicationLanguage,
    jobTitle: job?.title,
    jobDescription: job?.description,
    jobLocation: job?.locationText,
    jobWorkMode: job?.workMode,
    domain: company.canonicalDomain,
    siteLanguage: meta.siteLanguage ?? null,
    officeTexts: company.offices.map((o) => [o.district, o.address, o.city].filter(Boolean).join(' ')),
  });
}

function companyNotes(report: unknown) {
  const r = report as { summary?: string | null; roleNeedInference?: { text?: string | null } | null; applicationAngle?: string | null } | null;
  if (!r) return null;
  return { summary: r.summary ?? null, potential: r.roleNeedInference?.text ?? null, approach: r.applicationAngle ?? null };
}

export function intentForOpportunity(o: { category: string; jobId: string | null }): IntentType {
  if (o.category === 'needs_confirmation' && o.jobId) return 'job_application';
  return intentForCategory(o.category);
}

export function verifiedFactsText(c: CandidateProfile) {
  const facts = (c.verifiedFacts as { label: string; value: string }[]) ?? [];
  return [c.headline ?? '', c.experienceYears ? `${c.experienceYears} yıl` : '', ...facts.map((f) => `${f.label}: ${f.value}`)].join('\n');
}

const GENERATED_CONTENT = /^(letter|ai|template)/;
const MISALIGNED_SCAN_LIMIT = 400;

@Injectable()
export class DraftingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
    private readonly outbox: OutboxService,
    private readonly letters: LetterService,
    private readonly models: LearnedModelsService,
  ) {}

  /** İlanın başvuru e-postası varsa iletişim noktası olarak kaydeder (kaynaklı, amaç: ilan başvurusu). */
  async ensureJobContact(job: Job & { listings?: { canonicalUrl: string | null; isOfficial: boolean }[] }): Promise<ContactPoint | null> {
    if (!job.applyEmail || !isValidEmail(job.applyEmail)) return null;
    const official = job.listings?.some((l) => l.isOfficial) ?? true;
    return this.prisma.contactPoint.upsert({
      where: { companyId_email: { companyId: job.companyId, email: job.applyEmail.toLowerCase() } },
      create: {
        workspaceId: job.workspaceId,
        companyId: job.companyId,
        email: job.applyEmail.toLowerCase(),
        kind: 'job_apply',
        purpose: `İlan başvuru adresi: ${job.title}`,
        sourceUrl: job.listings?.[0]?.canonicalUrl ?? job.applyUrl,
        confidence: official ? 'high' : 'medium',
        ownershipEvidence: official ? 'Resmî ilan metninde yayımlanmış' : 'İkincil kaynakta yayımlanmış',
        verifiedAt: official ? new Date() : null,
        verifiedBy: official ? 'source' : null,
      },
      update: {},
    });
  }

  async defaultDocuments(candidateId: string, language = PRIMARY_LANGUAGE) {
    const docs = await this.prisma.documentVersion.findMany({ where: { candidateId, archived: false, scanState: 'clean' } });
    return attachmentsFor(docs, language);
  }

  async create(input: {
    workspaceId: string;
    candidateId: string;
    companyId: string;
    jobId?: string | null;
    opportunityId?: string | null;
    intentType?: IntentType;
    mailAccountId?: string | null;
    contactId?: string | null;
    documentIds?: string[];
    origin?: 'manual' | 'campaign' | 'automation' | 'follow_up';
    campaignId?: string | null;
    followUpOfId?: string | null;
    createdById?: string | null;
    allowManualAi?: boolean;
    useAi?: boolean;
    subjectTemplate?: string | null;
    bodyTemplate?: string | null;
    fresh?: boolean;
  }): Promise<ApplicationDraft & { aiTaskId?: string | null; aiStatus?: string }> {
    const candidate = await this.prisma.candidateProfile.findFirst({ where: { id: input.candidateId, workspaceId: input.workspaceId } });
    if (!candidate) throw notFound('Aday profili');
    const company = await this.prisma.company.findFirst({
      where: { id: input.companyId, workspaceId: input.workspaceId },
      include: { contacts: true, offices: { select: { city: true, district: true, address: true } }, evidence: { where: { accepted: true }, orderBy: { evidenceDate: 'desc' }, take: 6 } },
    });
    if (!company) throw notFound('Firma');
    let job: (Job & { listings: { canonicalUrl: string | null; isOfficial: boolean }[] }) | null = null;
    if (input.jobId) {
      job = await this.prisma.job.findFirst({ where: { id: input.jobId, workspaceId: input.workspaceId }, include: { listings: { select: { canonicalUrl: true, isOfficial: true } } } });
      if (!job) throw notFound('İlan');
    }
    let intent: IntentType = input.intentType ?? (job ? (job.status === 'closed' ? 'intent_after_closed' : 'job_application') : 'general_intent');
    if (intent === 'job_application' && !job) intent = 'general_intent';

    let contact: ContactPoint | null = null;
    if (input.contactId) {
      contact = company.contacts.find((c) => c.id === input.contactId) ?? null;
      if (!contact) throw notFound('İletişim noktası');
    } else {
      const ensured = job && intent === 'job_application' ? await this.ensureJobContact(job) : null;
      const jobContact = ensured && !ensured.suppressed ? ensured : null;
      contact = jobContact ?? pickContact(company.contacts.filter((c) => c.kind !== 'job_apply'), { domain: company.canonicalDomain, aliases: company.aliases, delivery: await this.models.deliveryFor(company) });
    }

    let mailAccountId = input.mailAccountId ?? null;
    if (mailAccountId) {
      const acc = await this.prisma.mailAccount.findFirst({ where: { id: mailAccountId, candidateId: candidate.id } });
      if (!acc) throw new AppError(422, 'ACCOUNT_NOT_OWNED', 'Gönderici hesabı bu adaya ait değil');
    } else {
      const acc = await this.prisma.mailAccount.findFirst({ where: { candidateId: candidate.id, health: 'ok' }, orderBy: { createdAt: 'asc' } });
      mailAccountId = acc?.id ?? null;
    }
    const { language } = languageForApplication(company, job);
    const documentIds = await this.documentsInLanguage(candidate.id, input.documentIds, language);

    const draft = await this.prisma.applicationDraft.create({
      data: {
        workspaceId: input.workspaceId,
        candidateId: candidate.id,
        opportunityId: input.opportunityId ?? null,
        companyId: company.id,
        jobId: job?.id ?? null,
        contactId: contact?.id ?? null,
        campaignId: input.campaignId ?? null,
        followUpOfId: input.followUpOfId ?? null,
        intentType: intent,
        language,
        mailAccountId,
        origin: input.origin ?? 'manual',
        createdById: input.createdById ?? null,
      },
    });

    const portfolioItems = ((candidate.portfolioItems ?? []) as any[]).slice(0, 12);
    const sources = company.evidence.map((e, i) => ({ id: `S${i + 1}`, url: e.url, excerpt: `${e.title}${e.customerName ? ` — ${e.customerName}` : ''}${e.evidenceDate ? ` (${e.evidenceDate.toISOString().slice(0, 7)})` : ''}: ${e.summary ?? ''}` }));
    const aiInput = {
      intent,
      intentLabel: INTENT_LABELS[intent],
      language,
      company: { name: company.name, services: company.services, sectors: company.sectors, notes: companyNotes(company.researchReport) },
      job: job ? { title: job.title, location: job.locationText, summary: (job.description ?? '').slice(0, 1500) } : null,
      targetTitle: job?.title ?? null,
      candidate: {
        name: candidate.displayName,
        headline: candidate.headline,
        portfolioUrl: candidate.portfolioUrl,
        signature: buildSignature(candidate),
        facts: candidate.verifiedFacts,
        experienceYears: candidate.experienceYears,
      },
      portfolioItems,
      sources,
    };
    const validation = {
      intent,
      verifiedFactsText: verifiedFactsText(candidate),
      allowedEmails: [candidate.email ?? ''].filter(Boolean),
      portfolioCount: portfolioItems.length,
      sourceIds: sources.map((s) => s.id),
    };

    let subject: string;
    let body: string;
    let generator = 'template';
    let aiTaskId: string | null = null;
    let aiStatus = 'none';
    if (input.subjectTemplate && input.bodyTemplate) {
      const { renderTemplate } = await import('../domain/templates');
      const work = portfolioItems[0];
      const vars = {
        company: company.name,
        title: job?.title ?? '',
        candidate_name: candidate.displayName,
        headline: candidate.headline ?? '',
        portfolio_url: candidate.portfolioUrl ?? '',
        signature: buildSignature(candidate),
        work_example: work ? `Örnek bir çalışmam: ${work.title}${work.client ? ` (${work.client})` : ''}.` : '',
      };
      subject = renderTemplate(input.subjectTemplate, vars);
      body = renderTemplate(input.bodyTemplate, vars);
    } else if (input.useAi !== false && isLetterIntent(intent)) {
      const letter = await this.letters.compose({ candidate, company, intent, jobTitle: job?.title ?? null, jobDescription: job?.description ?? null, fresh: input.fresh, createdById: input.createdById });
      subject = applicationSubject(intent, job?.title ?? null, candidate);
      body = letter.body;
      generator = letter.generator;
    } else if (input.useAi === false) {
      const { templateOutput } = await import('./ai/template-provider');
      const t = templateOutput('mail_draft', aiInput) as { subject: string; body: string };
      subject = t.subject;
      body = t.body;
    } else {
      const r = await this.ai.run({
        workspaceId: input.workspaceId,
        kind: 'mail_draft',
        input: aiInput,
        validation,
        entityType: 'ApplicationDraft',
        entityId: draft.id,
        createdById: input.createdById,
        context: { draftId: draft.id },
        allowManual: input.allowManualAi !== false,
        useCache: false,
      });
      if (r.status === 'succeeded') {
        subject = r.output.subject;
        body = r.output.body;
        generator = r.provider === 'template' ? 'template' : `ai:${r.provider}`;
        aiTaskId = r.taskId;
      } else {
        // Manuel köprü bekleniyor: şablon taslakla başla, cevap gelince yeni sürüm eklenir.
        const { templateOutput } = await import('./ai/template-provider');
        const t = templateOutput('mail_draft', aiInput) as { subject: string; body: string };
        subject = t.subject;
        body = t.body;
        aiTaskId = r.taskId;
        aiStatus = 'awaiting_user';
      }
    }

    let draftRecord = draft;
    let translationFailed = false;
    if (language === 'en' && textLanguage(body) !== 'en') {
      const translated = await this.translateText(input.workspaceId, draft.id, subject, body, input.createdById ?? null);
      if (translated) {
        body = translated.body;
        if (input.subjectTemplate || intent === 'follow_up') subject = translated.subject;
        generator = `${generator}+translate:en`;
      } else {
        translationFailed = true;
        draftRecord = await this.prisma.applicationDraft.update({ where: { id: draft.id }, data: { language: 'tr' } });
      }
    }
    if (!input.subjectTemplate && intent !== 'follow_up') subject = applicationSubject(intent, job?.title ?? null, candidate, draftRecord.language as ApplicationLanguage);
    const content: DraftContent = { toEmail: contact?.email ?? null, subject, body, documentIds, links: candidate.portfolioUrl ? [candidate.portfolioUrl] : [] };
    const rev = await this.addRevision(draftRecord, content, { createdById: input.createdById ?? null, generator, aiTaskId, sourceRefs: sources });
    if (translationFailed) await this.prisma.applicationDraft.update({ where: { id: draft.id }, data: { status: 'needs_review', blockedReasons: { push: ENGLISH_TRANSLATION_FAILED } } });
    return { ...(await this.prisma.applicationDraft.findUniqueOrThrow({ where: { id: draft.id } })), aiTaskId, aiStatus, ...{ revisionHash: rev.hash } };
  }

  /** İstenen ekler hedef dildeki sürümlerine çevrilir; ek verilmemişse adayın o dildeki varsayılan CV ve portföyü. */
  private async documentsInLanguage(candidateId: string, requested: string[] | undefined, language: ApplicationLanguage): Promise<string[]> {
    if (!requested) return this.defaultDocuments(candidateId, language);
    if (language === PRIMARY_LANGUAGE || !requested.length) return requested;
    const available = await this.prisma.documentVersion.findMany({ where: { candidateId, archived: false, scanState: 'clean' } });
    const attached = available.filter((d) => requested.includes(d.id));
    return attached.length === requested.length ? attachmentsInLanguage(attached, available, language) : requested;
  }

  private async translateText(workspaceId: string, draftId: string, subject: string, body: string, userId: string | null): Promise<{ subject: string; body: string } | null> {
    const r = await this.ai.run({
      workspaceId,
      kind: 'mail_translate',
      input: { targetLanguage: 'en', subject, body },
      entityType: 'ApplicationDraft',
      entityId: draftId,
      createdById: userId,
      allowManual: false,
      allowTemplate: false,
    });
    if (r.status !== 'succeeded') return null;
    const out = r.output as { subject: string; body: string };
    return { subject: out.subject.trim(), body: out.body.trim() };
  }

  /** Yeni taslak sürümü; ek/adres değişimi önceki onayı geçersiz kılar (hash değişir). */
  async translateDraft(draftId: string, targetLanguage: 'en' | 'tr', userId: string | null) {
    const draft = await this.prisma.applicationDraft.findUnique({ where: { id: draftId } });
    if (!draft || !['draft', 'needs_review'].includes(draft.status)) return { status: 'skipped' as const };
    const rev = await this.currentRevision(draft.id);
    if (!rev) return { status: 'skipped' as const };
    const r = await this.ai.run({
      workspaceId: draft.workspaceId,
      kind: 'mail_translate',
      input: { targetLanguage, subject: rev.subject, body: rev.body },
      entityType: 'ApplicationDraft',
      entityId: draft.id,
      createdById: userId,
      allowManual: false,
      allowTemplate: false,
    });
    if (r.status !== 'succeeded') return { status: r.status };
    const out = r.output as { subject: string; body: string };
    const [attached, available] = await Promise.all([
      this.prisma.documentVersion.findMany({ where: { id: { in: rev.documentIds }, candidateId: draft.candidateId } }),
      this.prisma.documentVersion.findMany({ where: { candidateId: draft.candidateId, archived: false, scanState: 'clean' } }),
    ]);
    const documentIds = attached.length === rev.documentIds.length ? attachmentsInLanguage(attached, available, targetLanguage) : rev.documentIds;
    const translated = await this.prisma.applicationDraft.update({ where: { id: draft.id }, data: { language: targetLanguage } });
    await this.addRevision(
      translated,
      { toEmail: rev.toEmail, subject: out.subject.trim(), body: out.body.trim(), documentIds, links: rev.links },
      { createdById: userId, generator: `ai:translate:${targetLanguage}`, aiTaskId: r.taskId, sourceRefs: rev.sourceRefs },
    );
    return { status: 'succeeded' as const };
  }

  async addRevision(
    draft: ApplicationDraft,
    content: DraftContent,
    meta: { createdById: string | null; generator: string; aiTaskId?: string | null; sourceRefs?: unknown; expectedRevision?: number },
    tx?: Tx,
  ) {
    const db = tx ?? this.prisma;
    if (GENERATED_CONTENT.test(meta.generator)) content = { ...content, subject: replaceAdWord(content.subject), body: replaceAdWord(content.body) };
    const candidate = await db.candidateProfile.findUniqueOrThrow({ where: { id: draft.candidateId } });
    const docs = content.documentIds.length
      ? await db.documentVersion.findMany({ where: { id: { in: content.documentIds } } })
      : [];
    if (docs.length !== content.documentIds.length || docs.some((d) => d.candidateId !== draft.candidateId)) {
      throw new AppError(422, 'DOCUMENT_NOT_OWNED', 'Seçilen belgeler bu adaya ait değil');
    }
    const check = checkDraftContent({
      intent: draft.intentType as IntentType,
      subject: content.subject,
      body: content.body,
      verifiedFactsText: verifiedFactsText(candidate),
      allowedEmails: [candidate.email ?? '', ...(content.toEmail ? [content.toEmail] : [])].filter(Boolean),
    });
    const blocked = [...check.problems];
    if (draft.intentType !== 'follow_up' && englishCvMissing(draft.language, docs)) blocked.push(ENGLISH_CV_MISSING);
    if (!content.toEmail) blocked.push('Alıcı adresi yok');
    else if (!isValidEmail(content.toEmail)) blocked.push('Alıcı adresi geçersiz');
    const hash = draftHash(content);
    const next = draft.currentRevision + 1;
    if (meta.expectedRevision !== undefined && meta.expectedRevision !== draft.currentRevision) {
      throw new AppError(409, 'REVISION_CONFLICT', 'Taslak başka bir ekranda değiştirilmiş; sayfayı yenileyin', { current: draft.currentRevision });
    }
    const res = await db.applicationDraft.updateMany({
      where: { id: draft.id, currentRevision: draft.currentRevision },
      data: { currentRevision: next, blockedReasons: blocked, status: draft.status === 'queued' ? 'queued' : blocked.length ? 'needs_review' : 'draft' },
    });
    if (res.count !== 1) throw new AppError(409, 'REVISION_CONFLICT', 'Taslak aynı anda değiştirildi');
    const rev = await db.draftRevision.create({
      data: {
        draftId: draft.id,
        revision: next,
        toEmail: content.toEmail,
        subject: content.subject,
        body: content.body,
        documentIds: content.documentIds,
        links: content.links,
        sourceRefs: (meta.sourceRefs ?? []) as Prisma.InputJsonValue,
        hash,
        generator: meta.generator,
        aiTaskId: meta.aiTaskId ?? null,
        createdById: meta.createdById,
      },
    });
    if (draft.status === 'queued') {
      // Kuyruktaki gönderim eski sürüme bağlı: worker hash uyuşmazlığında göndermez; kullanıcıya bildirilir.
      await this.outbox.emit(
        { workspaceId: draft.workspaceId, eventType: 'draft.changed_while_queued', aggregateId: draft.id, dedupKey: `draft-changed:${draft.id}:${next}`, payload: { draftId: draft.id } },
        tx,
      );
    }
    return rev;
  }

  async currentRevision(draftId: string) {
    const d = await this.prisma.applicationDraft.findUniqueOrThrow({ where: { id: draftId } });
    return this.prisma.draftRevision.findUnique({ where: { draftId_revision: { draftId, revision: d.currentRevision } } });
  }

  /** Manuel AI görevi tamamlandığında taslağa AI sürümü eklenir. */
  async applyAiDraft(taskId: string) {
    const task = await this.prisma.aiTask.findUnique({ where: { id: taskId } });
    if (!task || task.status !== 'succeeded') return;
    const draftId = (task.context as any)?.draftId as string | undefined;
    if (!draftId) return;
    const draft = await this.prisma.applicationDraft.findUnique({ where: { id: draftId } });
    if (!draft || !['draft', 'needs_review'].includes(draft.status)) return;
    const cur = await this.currentRevision(draftId);
    const out = task.output as any;
    await this.addRevision(
      draft,
      { toEmail: cur?.toEmail ?? null, subject: out.subject, body: out.body, documentIds: cur?.documentIds ?? [], links: cur?.links ?? [] },
      { createdById: task.createdById, generator: `ai:${task.provider}`, aiTaskId: task.id, sourceRefs: cur?.sourceRefs },
    );
  }

  /**
   * Dili firmaya/ilana uymayan, kullanıcının elle değiştirmediği taslaklar (ör. dil kuralı gelmeden Türkçe hazırlananlar
   * ya da firma için dil sonradan seçildiğinde). Kullanıcının düzenlediği taslağa dokunulmaz.
   */
  async misalignedDrafts(where: { workspaceId?: string; companyId?: string }, limit: number): Promise<{ draftId: string; language: ApplicationLanguage }[]> {
    const drafts = await this.prisma.applicationDraft.findMany({
      where: { ...where, status: { in: ['draft', 'needs_review'] }, revisions: { none: { generator: 'user' } }, intentType: { not: 'follow_up' } },
      orderBy: { updatedAt: 'desc' },
      take: MISALIGNED_SCAN_LIMIT,
      select: { id: true, language: true, companyId: true, jobId: true },
    });
    if (!drafts.length) return [];
    const [companies, jobs] = await Promise.all([
      this.prisma.company.findMany({ where: { id: { in: [...new Set(drafts.map((d) => d.companyId))] } }, select: { id: true, applicationLanguage: true, canonicalDomain: true, researchMeta: true, offices: { select: { city: true, district: true, address: true } } } }),
      this.prisma.job.findMany({ where: { id: { in: drafts.map((d) => d.jobId).filter((id): id is string => !!id) } }, select: { id: true, title: true, description: true, locationText: true, workMode: true } }),
    ]);
    const companyById = new Map(companies.map((c) => [c.id, c]));
    const jobById = new Map(jobs.map((j) => [j.id, j]));
    const result: { draftId: string; language: ApplicationLanguage }[] = [];
    for (const d of drafts) {
      const company = companyById.get(d.companyId);
      if (!company) continue;
      const { language } = languageForApplication(company, d.jobId ? (jobById.get(d.jobId) ?? null) : null);
      if (language !== d.language) result.push({ draftId: d.id, language });
      if (result.length >= limit) break;
    }
    return result;
  }

  describe(draft: ApplicationDraft, company: Company, job: Job | null) {
    return `${INTENT_LABELS[draft.intentType as IntentType]} — ${company.name}${job ? ` / ${job.title}` : ''}`;
  }
}
