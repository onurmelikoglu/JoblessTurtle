import { Body, Controller, Get, Injectable, Module, Param, Patch, Post, Put, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AutomationPolicy } from '@prisma/client';
import { z } from 'zod';
import { AdminOnly, Ctx, RequestContext } from '../../common/auth';
import { randomToken } from '../../common/crypto';
import { AppError, errorMessage, notFound } from '../../common/errors';
import { OutboxService } from '../../common/outbox.service';
import { PrismaService } from '../../common/prisma.service';
import { ZodPipe } from '../../common/zod.pipe';
import { HomeApplicationDetail, HomeApplications, HomeCompanies, HomeInboxWithAutopilot, HomeLetters, HomeOpportunity, HomePreview, HomeState, SetupStep, SizeSearchResult } from '../../contracts/home';
import { ServerShape } from '../../contracts/wire';
import { activityItems, activityStatus, ROUTINE_CRAWL } from '../../domain/activity';
import { companyLinks, jobApplyLinks, mergeLinks, replyApplyLink } from '../../domain/apply-links';
import { classOfCompany, classOfOpportunity, COMPANY_CLASSES, CompanyClass } from '../../domain/company-class';
import { employeeSizeOf } from '../../domain/company-size';
import { ENGLISH_LANGUAGE, pickDocument, replacementFor } from '../../domain/documents';
import { MANUAL_ONLY_KINDS } from '../../domain/contact-research';
import { contactSearchPlan } from '../../domain/contact-search';
import { CANDIDATE_HR_KIND, classifyPublishedEmail, isValidEmail, RecipientScoring, recipientScore, SENDABLE_CONTACT_KINDS, SUGGESTED_ONLY_KINDS } from '../../domain/contacts';
import { CITY_SELECTION_SEPARATOR, evaluateLocation, regionForSelections, workScopeOf } from '../../domain/geo';
import { normalizeCompanyName, preferTurkishUrl } from '../../domain/text';
import { AiService, DEFAULT_AI_SETTINGS } from '../../engine/ai/ai.service';
import { UsageService } from '../../common/usage.service';
import { SendingService } from '../../engine/sending.service';
import { AI_KIND_LABELS } from '../../engine/ai/schemas';
import { ActivityService } from '../../engine/activity.service';
import { careersLinkOfSource, DISCOVERED_SOURCE_KINDS } from '../../engine/connectors/defaults';
import { AutomationService, predraftBudget } from '../../engine/automation.service';
import { AutopilotService } from '../../engine/autopilot.service';
import { addressSearchExhausted, detailsNeeded, pickSegments, ResearchMeta, ResearchService, SIZE_BATCH } from '../../engine/research.service';
import { DraftingService, intentForOpportunity, pickContact } from '../../engine/drafting.service';
import { isLetterIntent, LETTER_INTENTS, LETTER_PLACEHOLDERS, LetterService } from '../../engine/letter.service';
import { InboxService } from '../../engine/inbox.service';
import { LearnedModelsService } from '../../engine/learned-models.service';
import { INBOUND_GROUP, INBOUND_LABELS, InboundCategory } from '../../domain/inbound';
import { INTENT_LABELS } from '../../domain/templates';
import { ApplicationsModule, ApplicationsService } from '../applications/applications.module';
import { CandidatesModule, CandidatesService } from '../candidates/candidates.module';

const CATEGORY_ORDER = ['target_open', 'adjacent_open', 'needs_confirmation', 'user_selected', 'past_closed', 'sector_target', 'not_found'];
const USER_SELECTED_CATEGORY = 'user_selected';
const CLI_PROVIDERS = ['cli_claude', 'cli_codex'];
const OPPORTUNITY_LIST_LIMIT = 2000;
const NEW_COMPANY_RESEARCH_WINDOW_MS = 30 * 60_000;
const ATTEMPT_REASON_LABELS: Record<string, string> = {
  DAILY_LIMIT: 'Mail hesabının günlük gönderim limiti doldu',
  PACING: 'Mailler arasında 30-50 sn bekleniyor',
  POLICY_DAILY_LIMIT: 'Otomatik başvurunun günlük limiti doldu',
  CAMPAIGN_PAUSED: 'Kampanya duraklatıldı',
  RECIPIENT_NOT_HR: 'Alıcı İK dışı bir adres (KVKK, destek vb.); başka bir adres seç',
  DOCUMENT_CHANGED: 'Yazı veya ekler sıraya alındıktan sonra değişti; yeniden gönder',
  SUPPRESSED: 'Bu adrese gönderim engelli',
  DEAD_ADDRESS: 'Adres geçersiz; başka bir adres seç',
  JOB_NOT_OPEN: 'İlan kapanmış',
  ACCOUNT_UNHEALTHY: 'Mail hesabı yeniden bağlanmalı',
  EMERGENCY_STOP: 'Acil durdurma açık',
  POLICY_CHANGED: 'Otomatik başvuru ayarları değişti',
  AUTOPILOT_OFF: 'Otomatik başvuru kapatıldı; düzeltme onayını bekliyor',
};

const RECIPIENT_KIND_LABELS: Record<string, string> = { job_apply: 'İlandaki başvuru adresi', official_hr: 'İK / kariyer', general: 'Genel iletişim', named_recruiter: 'İşe alım çalışanı', management: 'Yönetim', employee: 'Çalışan', guessed: 'Tahmini (yayımlanmamış)' };
const DELIVERY_VERIFIED_BY = 'delivery';

function recipientOptionsOf(
  applyEmail: string | null | undefined,
  contacts: { email: string; kind: string; suppressed: boolean; sourceUrl: string | null; verifiedAt: Date | null; verifiedBy: string | null; score: number | null; name: string | null; role: string | null }[],
  scoring: RecipientScoring,
) {
  const delivered = new Set(contacts.filter((c) => c.verifiedBy === DELIVERY_VERIFIED_BY).map((c) => c.email.toLowerCase()));
  const usable = (kinds: string[]) =>
    contacts
      .filter((c) => !c.suppressed && kinds.includes(c.kind) && isValidEmail(c.email))
      .sort((a, b) => recipientScore(b, scoring) - recipientScore(a, scoring))
      .map((c) => ({ email: c.email.toLowerCase(), kind: c.kind, sourceUrl: c.sourceUrl, verified: !!c.verifiedAt, score: c.score, person: [c.name, c.role].filter(Boolean).join(', ') || null }));
  const options = [
    ...(applyEmail ? [{ email: applyEmail.toLowerCase(), kind: 'job_apply', sourceUrl: null as string | null, verified: true, score: null as number | null, person: null as string | null }] : []),
    ...usable(SENDABLE_CONTACT_KINDS),
    ...usable(MANUAL_ONLY_KINDS),
  ];
  const seen = new Set<string>();
  return options
    .filter((o) => !seen.has(o.email) && seen.add(o.email))
    .map((o) => ({ ...o, delivered: delivered.has(o.email), label: RECIPIENT_KIND_LABELS[o.kind] ?? o.kind, manualOnly: MANUAL_ONLY_KINDS.includes(o.kind) }));
}
const ACTIVE_DRAFT_STATES = ['draft', 'needs_review', 'queued', 'sent'];
const EDITABLE_DRAFT_STATES = ['draft', 'needs_review'];
const FORM_CHANNELS = ['ats_form', 'platform'];
const DEFAULT_SEARCH_NAME = 'Ana arama';
const DEFAULT_POLICY_NAME = 'Otomatik başvuru';
const STRONG_FIT_SCORE = 80;
const MAX_APPLY_BATCH = 500;
const APPLICATIONS_LIST_LIMIT = 1000;
const NOT_APPLIED_ATTEMPT_STATES = ['cancelled', 'blocked', 'failed_confirmed'];
const DEEP_DISCOVERY_LIMIT = 25;
const OFFICE_REFRESH_LIMIT = 100;
const DETAILS_REFRESH_LIMIT = 30;
const INVITEE_DISCOVERY_SEGMENTS = 3;
const AI_NEAR_LIMIT_RATIO = 0.9;
const BULK_DETAILS_LIMIT = 40;
/** Kullanıcının tek istekte başlatabileceği çalışan sayısı araması (her grup tek yapay zekâ çağrısı). */
const SIZE_SEARCH_BATCHES = 15;
/** "Yeniden ara" ile bir kerede başlatılan ilan arama sorgusu (her biri tek yapay zekâ çağrısı). */
const USER_JOB_QUERIES = 6;
const RESEARCH_REFRESH_HOURS = 6;
const IN_REGION_STATES = ['primary', 'conditional'];

const profileSchema = z.object({
  displayName: z.string().trim().min(1).max(120),
  email: z.string().email().optional().nullable(),
  headline: z.string().trim().max(600).optional().nullable(),
  portfolioUrl: z.string().url().optional().nullable(),
  signature: z.string().trim().max(1000).optional().nullable(),
  positions: z.array(z.string().trim().min(1)).max(20).optional(),
  adjacentPositions: z.array(z.string().trim().min(1)).max(40).optional(),
  city: z.string().trim().max(80).optional().nullable(),
  cities: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
  allowRemote: z.boolean().optional(),
  abroadRemote: z.boolean().optional(),
  abroadRelocation: z.boolean().optional(),
  abroadRegions: z.array(z.string().trim().min(1).max(60)).max(12).optional(),
});
const applySchema = z.object({ opportunityIds: z.array(z.string()).min(1).max(MAX_APPLY_BATCH) });
const autoApplySchema = z.object({ enabled: z.boolean() });
const markAppliedSchema = z.object({ opportunityId: z.string() });
const letterSchema = z.object({ body: z.string().trim().min(50).max(6000) });
const letterStyleSchema = z.object({ text: z.string().trim().min(50).max(6000) });
const missingEmailsSchema = z.object({ force: z.boolean().default(false) });
const removeSchema = z.object({ ids: z.array(z.string()).min(1).max(200) });
const retrySchema = z.object({ ids: z.array(z.string()).min(1).max(200).optional() });
const mailLimitSchema = z.object({ dailyLimit: z.number().int().min(1).max(500) });
const lookupSchema = z.object({ name: z.string().trim().min(2).max(160) });
const targetedSearchSchema = z.object({ query: z.string().trim().min(3).max(160) });
const translateSchema = z.object({ lang: z.enum(['en', 'tr']) });
const letterExampleSchema = z.object({ text: z.string().trim().max(4000).nullable() });
const letterGuideSchema = z.object({ text: z.string().trim().min(50).max(12000) });
const resendSchema = z.object({ toEmail: z.string().trim().email(), subject: z.string().trim().min(3).max(300), body: z.string().trim().min(20).max(12000), documentIds: z.array(z.string()).max(10).optional() });
const resendManySchema = z.object({ ids: z.array(z.string()).min(1).max(200) });
const inboxStatusSchema = z.object({ ids: z.array(z.string()).min(1).max(500), status: z.enum(['open', 'resolved', 'ignored']) });
const inboxSettingsSchema = z.object({ enabled: z.boolean() });
const autopilotIdsSchema = z.object({ ids: z.array(z.string()).min(1).max(200) });
const serverSettingsSchema = z.object({ shareCliWithInvitees: z.boolean().optional(), inviteeDailyLimit: z.number().int().min(0).max(5000).optional() });

type PolicySyncResult = { policy: AutomationPolicy | null; blocker: string | null };

@Injectable()
export class HomeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly ai: AiService,
    private readonly automation: AutomationService,
    private readonly candidates: CandidatesService,
    private readonly drafting: DraftingService,
    private readonly applicationsService: ApplicationsService,
    private readonly letterService: LetterService,
    private readonly research: ResearchService,
    private readonly usage: UsageService,
    private readonly sending: SendingService,
    private readonly activity: ActivityService,
    private readonly models: LearnedModelsService,
  ) {}

  private async primary(workspaceId: string) {
    const candidate = await this.prisma.candidateProfile.findFirst({
      where: { workspaceId },
      orderBy: { createdAt: 'asc' },
      include: {
        searchProfiles: { orderBy: { createdAt: 'asc' } },
        mailAccounts: { select: { id: true, provider: true, accountEmail: true, health: true, dailyLimit: true }, orderBy: { createdAt: 'asc' } },
        documents: { where: { archived: false, type: { in: ['cv', 'portfolio'] } }, orderBy: { createdAt: 'desc' } },
      },
    });
    const searchProfile = candidate?.searchProfiles.find((p) => p.active) ?? candidate?.searchProfiles[0] ?? null;
    return { candidate, searchProfile };
  }

  async state(ctx: RequestContext): Promise<ServerShape<HomeState>> {
    const { candidate, searchProfile } = await this.primary(ctx.workspaceId);
    const ws = ctx.workspaceId;
    const policy = candidate && searchProfile ? await this.prisma.automationPolicy.findFirst({ where: { workspaceId: ws, candidateId: candidate.id, searchProfileId: searchProfile.id }, orderBy: { createdAt: 'desc' } }) : null;
    const [companies, aiWaiting, suggestions, applied, replied, aiSettings, lettersReady, lettersPending, aiUsedToday, paused, work] = await Promise.all([
      this.prisma.company.count({ where: { workspaceId: ws, excluded: false } }),
      this.prisma.aiTask.findMany({ where: { workspaceId: ws, status: 'awaiting_user' }, orderBy: { createdAt: 'asc' }, select: { id: true, kind: true, createdAt: true } }),
      this.prisma.opportunity.count({ where: { workspaceId: ws, category: { in: CATEGORY_ORDER }, status: { notIn: ['dismissed', 'applied'] } } }),
      this.prisma.applicationAttempt.count({ where: { workspaceId: ws, state: { notIn: ['cancelled'] } } }),
      this.prisma.applicationAttempt.count({ where: { workspaceId: ws, state: { in: ['replied', 'outcome_recorded'] } } }),
      this.ai.settings(ws),
      this.prisma.applicationDraft.count({ where: { workspaceId: ws, status: { in: EDITABLE_DRAFT_STATES }, opportunityId: { not: null } } }),
      policy?.active ? this.automation.pendingPredrafts(ws) : Promise.resolve(0),
      this.usage.get(ws, 'ai:tasks'),
      this.research.isPaused(ws),
      this.activity.counts(ws),
    ]);
    const [cooldowns, limits, schedule, classes] = await Promise.all([
      aiSettings.cliAllowed ? this.ai.cooldowns() : Promise.resolve<Record<string, string | undefined>>({}),
      aiSettings.cliAllowed && aiSettings.ownerIsAdmin ? this.ai.limitUsage() : Promise.resolve({}),
      this.activity.schedule(ws, { dailyDiscovery: aiSettings.dailyDiscovery !== false, paused, lettersPending: lettersPending > 0 }),
      this.ai.classStatus(ws),
    ]);
    const aiAutomatic = aiSettings.cliAllowed && aiSettings.providerOrder[0] === 'cli_claude';
    const limitReached = aiUsedToday >= aiSettings.dailyTaskLimit;
    const waitingForBudget = lettersPending > 0 && predraftBudget(aiSettings.dailyTaskLimit, aiUsedToday) === 0;
    const cliProviders = aiSettings.cliAllowed ? aiSettings.providerOrder.filter((p) => CLI_PROVIDERS.includes(p)) : [];
    const providersCooling = cliProviders.length > 0 && cliProviders.every((p) => cooldowns[p]);
    const documents = candidate?.documents ?? [];
    const cv = pickDocument(documents, 'cv');
    const portfolio = pickDocument(documents, 'portfolio');
    const englishOf = (type: string) => {
      const doc = documents.find((d) => d.type === type && d.language === ENGLISH_LANGUAGE);
      return doc ? { id: doc.id, fileName: doc.fileName, scanState: doc.scanState } : null;
    };
    const mailAccount = candidate?.mailAccounts[0] ?? null;
    const missing: SetupStep[] = [];
    if (!candidate) missing.push('profile');
    if (!cv) missing.push('cv');
    if (!searchProfile?.exactTitles.length) missing.push('positions');
    if (!mailAccount) missing.push('mail');
    return {
      setup: {
        complete: missing.length === 0,
        missing,
        candidate: candidate && { id: candidate.id, displayName: candidate.displayName, email: candidate.email, headline: candidate.headline, portfolioUrl: candidate.portfolioUrl, signature: candidate.signature },
        cv: cv && { id: cv.id, fileName: cv.fileName, scanState: cv.scanState, createdAt: cv.createdAt },
        portfolio: portfolio && { id: portfolio.id, fileName: portfolio.fileName, scanState: portfolio.scanState },
        english: { cv: englishOf('cv'), portfolio: englishOf('portfolio') },
        positions: searchProfile?.exactTitles ?? [],
        adjacentPositions: searchProfile?.adjacentTitles ?? [],
        cities: (candidate?.city ?? searchProfile?.city ?? '').split(CITY_SELECTION_SEPARATOR).filter(Boolean),
        allowRemote: searchProfile?.allowRemote ?? false,
        abroadRemote: searchProfile?.abroadRemote ?? false,
        abroadRelocation: searchProfile?.abroadRelocation ?? false,
        abroadRegions: searchProfile?.abroadRegions ?? [],
        searchProfileId: searchProfile?.id ?? null,
        mailAccount,
      },
      autoApply: { policyId: policy?.id ?? null, active: policy?.active ?? false, autoSend: policy?.autoSend ?? false },
      activity: {
        status: activityStatus({ paused, counts: work.counts, backlogLetters: lettersPending, aiBlocked: waitingForBudget || limitReached || providersCooling }),
        workerOnline: work.workerOnline,
        items: activityItems(work.counts),
        routineCrawls: (work.counts[ROUTINE_CRAWL]?.running ?? 0) + (work.counts[ROUTINE_CRAWL]?.queued ?? 0),
        companies,
        ...schedule,
        backlog: { letters: lettersPending, lettersReady, waitingForBudget },
      },
      counts: { suggestions, applied, replied },
      aiWaiting: aiAutomatic ? [] : aiWaiting.map((t) => ({ ...t, label: AI_KIND_LABELS[t.kind as keyof typeof AI_KIND_LABELS] ?? t.kind })),
      ai: {
        automatic: aiAutomatic,
        usedToday: aiUsedToday,
        dailyLimit: aiSettings.dailyTaskLimit,
        limitReached,
        nearLimit: aiUsedToday >= Math.floor(aiSettings.dailyTaskLimit * AI_NEAR_LIMIT_RATIO),
        cooldowns,
        limits,
        classes,
      },
    };
  }

  async saveProfile(ctx: RequestContext, input: z.infer<typeof profileSchema>) {
    const { candidate: existing, searchProfile } = await this.primary(ctx.workspaceId);
    const cities = input.cities ?? (input.city ? [input.city] : []);
    const candidateData = {
      displayName: input.displayName,
      email: input.email ?? null,
      headline: input.headline ?? null,
      portfolioUrl: input.portfolioUrl ?? null,
      signature: input.signature ?? null,
      city: cities.length ? cities.join(CITY_SELECTION_SEPARATOR) : null,
    };
    const candidate = existing ? await this.candidates.update(ctx, existing.id, candidateData) : await this.candidates.create(ctx, { ...candidateData, verifiedFacts: [], languages: [], workModes: [], employmentTypes: [], portfolioItems: [] });
    if (input.positions?.length) {
      const region = {
        ...regionForSelections(cities),
        allowRemote: input.allowRemote ?? false,
        allowHybrid: true,
        abroadRemote: input.abroadRemote ?? searchProfile?.abroadRemote ?? false,
        abroadRelocation: input.abroadRelocation ?? searchProfile?.abroadRelocation ?? false,
        abroadRegions: input.abroadRegions ?? searchProfile?.abroadRegions ?? [],
      };
      const positionsChanged = !searchProfile || searchProfile.exactTitles.join('|') !== input.positions.join('|');
      const adjacent = input.adjacentPositions ? { adjacentTitles: input.adjacentPositions } : {};
      let profileId: string;
      if (searchProfile) {
        profileId = searchProfile.id;
        await this.candidates.updateProfile(ctx, searchProfile.id, { revision: searchProfile.revision, exactTitles: input.positions, active: true, ...adjacent, ...region });
      } else {
        profileId = (await this.candidates.createProfile(ctx, {
          candidateId: candidate.id,
          name: DEFAULT_SEARCH_NAME,
          exactTitles: input.positions,
          adjacentTitles: [],
          excludedTitles: [],
          sectors: [],
          excludedSectors: [],
          keywords: [],
          districtsConditional: [],
          unknownLocationAction: 'review',
          autoIncludeAdjacent: false,
          requiredConditions: [],
          active: true,
          ...region,
        })).id;
      }
      if (positionsChanged) {
        await this.emitTitleExpansion(ctx, profileId);
        await this.emitDeepDiscovery(ctx, profileId, Date.now());
      }
    }
    const sync = await this.syncPolicy(ctx);
    return { ...(await this.state(ctx)), policyBlocker: sync.blocker };
  }

  async syncPolicy(ctx: RequestContext, autoSend?: boolean): Promise<PolicySyncResult> {
    const { candidate, searchProfile } = await this.primary(ctx.workspaceId);
    if (!candidate || !searchProfile) return { policy: null, blocker: 'Önce profil ve aradığınız pozisyonlar kaydedilmeli' };
    const mail = candidate.mailAccounts.find((m) => m.health === 'ok');
    if (!mail) return { policy: null, blocker: 'Gönderim için bir mail hesabı bağlanmalı' };
    const documentIds = await this.automation.defaultDocumentIds(candidate.id);
    if (!documentIds.length) return { policy: null, blocker: 'Taranmış bir CV yüklenmeli' };
    let policy = await this.prisma.automationPolicy.findFirst({ where: { workspaceId: ctx.workspaceId, candidateId: candidate.id, searchProfileId: searchProfile.id }, orderBy: { createdAt: 'desc' } });
    const desired = { mailAccountId: mail.id, documentIds, autoSend: autoSend ?? policy?.autoSend ?? false };
    if (!policy) {
      policy = await this.prisma.automationPolicy.create({
        data: { workspaceId: ctx.workspaceId, candidateId: candidate.id, searchProfileId: searchProfile.id, name: DEFAULT_POLICY_NAME, modeJobApplication: true, ...desired },
      });
    } else {
      const changed = policy.mailAccountId !== desired.mailAccountId || policy.autoSend !== desired.autoSend || [...policy.documentIds].sort().join() !== [...desired.documentIds].sort().join();
      if (changed) {
        if (policy.active) await this.automation.deactivate(policy.id, ctx.workspaceId, ctx.userId);
        policy = await this.prisma.automationPolicy.update({ where: { id: policy.id }, data: desired });
      }
    }
    if (!policy.active) {
      try {
        policy = await this.automation.activate(policy.id, ctx.workspaceId, ctx.userId);
      } catch (e) {
        return { policy, blocker: errorMessage(e) };
      }
    }
    return { policy, blocker: null };
  }

  async setAutoApply(ctx: RequestContext, enabled: boolean) {
    const sync = await this.syncPolicy(ctx, enabled);
    if (sync.blocker) throw new AppError(422, 'AUTO_APPLY_BLOCKED', sync.blocker);
    return this.state(ctx);
  }

  private async emitDeepDiscovery(ctx: RequestContext, searchProfileId: string, stamp: number) {
    const settings = await this.ai.settings(ctx.workspaceId);
    const all = pickSegments(await this.research.segmentLog(searchProfileId), { skipExhausted: true });
    const segments = settings.ownerIsAdmin ? all : all.slice(0, INVITEE_DISCOVERY_SEGMENTS);
    const limit = settings.ownerIsAdmin ? DEEP_DISCOVERY_LIMIT : (settings.discoveryLimit ?? DEFAULT_AI_SETTINGS.discoveryLimit);
    for (const [i, focus] of segments.entries()) {
      await this.outbox.emit({
        workspaceId: ctx.workspaceId,
        eventType: 'discovery.ai',
        aggregateId: ctx.workspaceId,
        dedupKey: `discovery:deep:${searchProfileId}:${stamp}:${i}`,
        payload: { searchProfileId, actorId: ctx.userId, allowManual: false, limit, focus },
      });
    }
  }

  private emitTitleExpansion(ctx: RequestContext, searchProfileId: string) {
    return this.outbox.emit({ workspaceId: ctx.workspaceId, eventType: 'profile.expand_titles', aggregateId: searchProfileId, dedupKey: `expand-titles:${searchProfileId}:${Date.now()}`, payload: { actorId: ctx.userId } });
  }

  async stopSearch(ctx: RequestContext) {
    await this.research.setPaused(ctx.workspaceId, true);
    await this.outbox.emit({ workspaceId: ctx.workspaceId, eventType: 'search.stop', aggregateId: ctx.workspaceId, dedupKey: `search-stop:${ctx.workspaceId}:${Date.now()}` });
    return this.state(ctx);
  }

  async search(ctx: RequestContext) {
    const { searchProfile } = await this.primary(ctx.workspaceId);
    if (!searchProfile?.exactTitles.length) throw new AppError(422, 'PROFILE_MISSING', 'Önce aradığınız pozisyonları girin');
    await this.research.setPaused(ctx.workspaceId, false);
    const stamp = Date.now();
    if (!searchProfile.adjacentTitles.length) await this.emitTitleExpansion(ctx, searchProfile.id);
    await this.emitDeepDiscovery(ctx, searchProfile.id, stamp);
    const companies = await this.prisma.company.findMany({
      where: { workspaceId: ctx.workspaceId, excluded: false },
      select: {
        id: true,
        lastResearchedAt: true,
        researchMeta: true,
        _count: { select: { contacts: { where: { suppressed: false, kind: { in: ['official_hr', 'job_apply'] } } }, offices: { where: { locationConfidence: { in: ['medium', 'high'] } } }, jobs: { where: { status: 'open' } } } },
      },
    });
    const recentCutoff = stamp - RESEARCH_REFRESH_HOURS * 3_600_000;
    const neverResearched = companies.filter((c) => !c.lastResearchedAt).slice(0, OFFICE_REFRESH_LIMIT);
    const missingDetails = companies
      .filter((c) => c.lastResearchedAt && c.lastResearchedAt.getTime() < recentCutoff && detailsNeeded({ researchMeta: c.researchMeta, hrContacts: c._count.contacts, knownOffices: c._count.offices }, stamp))
      .sort((a, b) => b._count.jobs - a._count.jobs)
      .slice(0, DETAILS_REFRESH_LIMIT);
    for (const c of neverResearched) {
      await this.outbox.emit({ workspaceId: ctx.workspaceId, eventType: 'research.company', aggregateId: c.id, dedupKey: `research:${c.id}:home:${stamp}`, payload: { companyId: c.id, actorId: ctx.userId } });
    }
    for (const c of missingDetails) {
      await this.outbox.emit({ workspaceId: ctx.workspaceId, eventType: 'research.details.bg', aggregateId: c.id, dedupKey: `research-details:${c.id}:home:${stamp}`, payload: { actorId: ctx.userId } });
    }
    await this.outbox.emit({ workspaceId: ctx.workspaceId, eventType: 'collect.all', aggregateId: ctx.workspaceId, dedupKey: `collect:home:${stamp}` });
    await this.outbox.emit({ workspaceId: ctx.workspaceId, eventType: 'evaluate.profile', aggregateId: searchProfile.id, dedupKey: `eval-profile:${searchProfile.id}:home:${stamp}` });
    await this.outbox.emit({
      workspaceId: ctx.workspaceId,
      eventType: 'jobs.plan',
      aggregateId: searchProfile.id,
      dedupKey: `jobs-plan:${searchProfile.id}:home:${stamp}`,
      payload: { searchProfileId: searchProfile.id, count: USER_JOB_QUERIES, actorId: ctx.userId, userTriggered: true },
    });
    return { ok: true };
  }

  /** Arama kutusuna yazılan serbest metinle ("Ankara fintech iOS") tek seferlik ilan araması başlatır. */
  async targetedSearch(ctx: RequestContext, query: string) {
    const { searchProfile } = await this.primary(ctx.workspaceId);
    if (!searchProfile?.exactTitles.length) throw new AppError(422, 'PROFILE_MISSING', 'Önce aradığınız pozisyonları girin');
    await this.outbox.emit({
      workspaceId: ctx.workspaceId,
      eventType: 'jobs.search',
      aggregateId: searchProfile.id,
      dedupKey: `jobs-search:${searchProfile.id}:focus:${Date.now()}`,
      payload: { focus: query, actorId: ctx.userId, userTriggered: true },
    });
    return { queued: true };
  }

  async opportunities(ctx: RequestContext): Promise<{ items: ServerShape<HomeOpportunity>[] }> {
    const rows = await this.prisma.opportunity.findMany({
      where: { workspaceId: ctx.workspaceId, category: { in: CATEGORY_ORDER }, status: { notIn: ['dismissed'] } },
      orderBy: [{ f: { sort: 'desc', nulls: 'last' } }, { computedAt: 'desc' }],
      take: OPPORTUNITY_LIST_LIMIT,
      include: {
        company: { select: { id: true, name: true, website: true, careersUrl: true, researchReport: true, researchMeta: true, groupName: true, employeeRange: true, origin: true, contacts: { where: { suppressed: false, kind: { in: [...SENDABLE_CONTACT_KINDS, ...SUGGESTED_ONLY_KINDS, ...MANUAL_ONLY_KINDS] } }, select: { id: true, kind: true, email: true, sourceUrl: true, ownershipEvidence: true } } } },
        job: { select: { id: true, title: true, locationText: true, workMode: true, firstSeenAt: true, applyUrl: true, applyEmail: true, channel: true, listings: { select: { applyUrl: true, canonicalUrl: true } } } },
      },
    });
    const ids = rows.map((r) => r.id);
    const drafts = await this.prisma.applicationDraft.findMany({ where: { opportunityId: { in: ids }, status: { in: ACTIVE_DRAFT_STATES } }, orderBy: { createdAt: 'desc' } });
    const latestDraft = new Map<string, (typeof drafts)[number]>();
    for (const d of drafts) if (d.opportunityId && !latestDraft.has(d.opportunityId)) latestDraft.set(d.opportunityId, d);
    const revisions = latestDraft.size ? await this.prisma.draftRevision.findMany({ where: { OR: [...latestDraft.values()].map((d) => ({ draftId: d.id, revision: d.currentRevision })) } }) : [];
    const revisionByDraft = new Map(revisions.map((r) => [r.draftId, r]));
    const ranker = await this.models.opportunityRanker(ctx.workspaceId);
    const items = rows
      .filter((o) => !['queued', 'sent'].includes(latestDraft.get(o.id)?.status ?? '') && o.status !== 'applied')
      .sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category))
      .map((o) => {
        const d = latestDraft.get(o.id);
        const rev = d ? revisionByDraft.get(d.id) : null;
        const canEmail = !!(rev?.toEmail || o.job?.applyEmail || o.company.contacts.some((c) => SENDABLE_CONTACT_KINDS.includes(c.kind)));
        return {
          id: o.id,
          companyId: o.companyId,
          jobId: o.jobId,
          title: o.job?.title ?? null,
          category: o.category,
          company: o.company.name,
          website: o.company.website,
          careersUrl: o.company.careersUrl,
          location: o.job?.locationText ?? null,
          scope: o.job ? workScopeOf(o.job.locationText, o.job.workMode) : ('local' as const),
          applyUrl: o.job?.applyUrl ?? null,
          formOnly: !canEmail && !!o.job?.applyUrl && FORM_CHANNELS.includes(o.job.channel),
          canEmail,
          groupSuggestion: canEmail ? null : groupSuggestionOf(o.company),
          emailSearchExhausted: !canEmail && addressSearchExhausted(o.company.researchMeta),
          manualRecipients: o.company.contacts.filter((c) => c.kind === 'management' || c.kind === 'employee').length,
          fit: fitLabel(o.category, o.f),
          summary: summarize(o),
          analysis: analysisOf(o.company.researchReport),
          draft: d && rev ? { id: d.id, status: d.status, revision: d.currentRevision, subject: rev.subject, body: rev.body, toEmail: rev.toEmail, problems: d.blockedReasons } : null,
          links: o.job ? jobApplyLinks(o.job) : [],
          foundAt: o.createdAt,
          rank: ranker
            ? ranker({
                category: o.category,
                intent: intentForOpportunity(o),
                kind: o.job?.applyEmail ? 'job_apply' : (o.company.contacts.find((c) => SENDABLE_CONTACT_KINDS.includes(c.kind))?.kind ?? null),
                employeeRange: o.company.employeeRange,
                hasJob: !!o.jobId,
                companyOrigin: o.company.origin,
                titleMatch: o.titleMatch,
                locationState: o.locationState,
              })
            : null,
        };
      });
    return { items };
  }

  /**
   * "Başvurmadığım firmalar": başvurulan firma hiçbir koşulda listelenmez; kalan her firma tek sınıfa düşer
   * (açık ilan / geçmişte açmış / potansiyel). Görünür fırsatı kalmayan firma (ör. kullanıcı gizledi) listede yer almaz.
   */
  async companies(ctx: RequestContext): Promise<ServerShape<HomeCompanies>> {
    const { searchProfile } = await this.primary(ctx.workspaceId);
    const [{ items }, companies, appliedRows, researchTasks, dismissedRows] = await Promise.all([
      this.opportunities(ctx),
      this.prisma.company.findMany({
        where: { workspaceId: ctx.workspaceId, excluded: false },
        select: {
          id: true,
          name: true,
          website: true,
          careersUrl: true,
          sectors: true,
          employeeRange: true,
          employeeCount: true,
          createdAt: true,
          lastResearchedAt: true,
          researchReport: true,
          sources: { where: { enabled: true, kind: { in: DISCOVERED_SOURCE_KINDS } }, select: { kind: true, config: true } },
          offices: { select: { id: true, label: true, kind: true, city: true, district: true, address: true }, orderBy: { kind: 'asc' } },
        },
      }),
      this.prisma.applicationAttempt.findMany({ where: { workspaceId: ctx.workspaceId, state: { notIn: NOT_APPLIED_ATTEMPT_STATES } }, select: { companyId: true }, distinct: ['companyId'] }),
      this.prisma.aiTask.findMany({ where: { workspaceId: ctx.workspaceId, entityType: 'Company', status: { in: ['pending', 'running'] }, kind: { in: ['company_report', 'company_contacts'] } }, select: { entityId: true } }),
      this.prisma.opportunity.findMany({ where: { workspaceId: ctx.workspaceId, status: 'dismissed' }, select: { companyId: true }, distinct: ['companyId'] }),
    ]);
    const appliedCompanyIds = new Set(appliedRows.map((a) => a.companyId));
    const dismissedCompanyIds = new Set(dismissedRows.map((o) => o.companyId));
    const activeResearch = new Set(researchTasks.map((t) => t.entityId));
    const opportunitiesByCompany = new Map<string, typeof items>();
    for (const item of items) opportunitiesByCompany.set(item.companyId, [...(opportunitiesByCompany.get(item.companyId) ?? []), item]);
    const listed = companies.filter((c) => !appliedCompanyIds.has(c.id));
    const result = listed.flatMap((c) => {
      const opportunities = opportunitiesByCompany.get(c.id) ?? [];
      const researching = activeResearch.has(c.id) || (!c.lastResearchedAt && Date.now() - c.createdAt.getTime() < NEW_COMPANY_RESEARCH_WINDOW_MS);
      const awaitingFirstResult = researching && !dismissedCompanyIds.has(c.id);
      const companyClass: CompanyClass | null = classOfCompany(opportunities) ?? (awaitingFirstResult ? 'potential' : null);
      if (!companyClass) return [];
      const offices = c.offices.map((o) => ({
        ...o,
        inRegion: searchProfile ? IN_REGION_STATES.includes(evaluateLocation(searchProfile, [o.district, o.address, o.city].filter(Boolean).join(' '))) : false,
      }));
      const careersUrl = preferTurkishUrl([c.careersUrl, ...c.sources.map(careersLinkOfSource)]);
      const regionMatch: 'yes' | 'no' | 'unknown' = offices.length === 0 ? 'unknown' : offices.some((o) => o.inRegion) ? 'yes' : 'no';
      return [
        {
          id: c.id,
          name: c.name,
          website: c.website,
          careersUrl,
          class: companyClass,
          sectors: c.sectors,
          cities: distinctCities(c.offices.map((o) => o.city)),
          employees: employeeSizeOf(c),
          analysis: analysisOf(c.researchReport),
          offices,
          regionMatch,
          opportunities,
          matchingJobs: opportunities.filter((o) => o.jobId && classOfOpportunity(o) === 'open').length,
          researching,
          links: companyLinks({ careersUrl, website: c.website }),
          foundAt: c.createdAt,
        },
      ];
    });
    const rankOf = (c: { opportunities: { rank: number | null }[] }) => Math.max(0, ...c.opportunities.map((o) => o.rank ?? 0));
    result.sort((a, b) => COMPANY_CLASSES.indexOf(a.class) - COMPANY_CLASSES.indexOf(b.class) || b.matchingJobs - a.matchingJobs || rankOf(b) - rankOf(a) || a.name.localeCompare(b.name, 'tr'));
    const byClass = Object.fromEntries(COMPANY_CLASSES.map((k) => [k, result.filter((c) => c.class === k).length])) as Record<CompanyClass, number>;
    return {
      companies: result,
      totals: {
        companies: result.length,
        applied: companies.filter((c) => appliedCompanyIds.has(c.id)).length,
        matchingJobs: result.reduce((n, c) => n + c.matchingJobs, 0),
        byClass,
        sizeUnknown: result.filter((c) => !c.employees).length,
      },
    };
  }

  /** Çalışan sayısı bilinmeyen firmalar için araştırma başlatır; ortak katalogda bilinenler yapay zekâya sorulmaz. */
  async researchSizes(ctx: RequestContext): Promise<SizeSearchResult> {
    const due = await this.research.sizeCandidates(ctx.workspaceId, Number.MAX_SAFE_INTEGER);
    const queued = due.slice(0, SIZE_BATCH * SIZE_SEARCH_BATCHES);
    const stamp = Date.now();
    for (let i = 0; i < queued.length; i += SIZE_BATCH) {
      await this.outbox.emit({
        workspaceId: ctx.workspaceId,
        eventType: 'research.sizes',
        aggregateId: ctx.workspaceId,
        dedupKey: `research-sizes:${ctx.workspaceId}:${stamp}:${i}`,
        payload: { companyIds: queued.slice(i, i + SIZE_BATCH), actorId: ctx.userId, userTriggered: true },
      });
    }
    return { queued: queued.length, remaining: due.length - queued.length };
  }

  async applications(ctx: RequestContext): Promise<ServerShape<HomeApplications>> {
    const attempts = await this.prisma.applicationAttempt.findMany({ where: { workspaceId: ctx.workspaceId, state: { not: 'cancelled' }, hiddenAt: null }, orderBy: { createdAt: 'desc' }, take: APPLICATIONS_LIST_LIMIT });
    const attemptIds = attempts.map((a) => a.id);
    const retried = new Set(attempts.map((a) => a.retryOfId).filter((x): x is string => !!x));
    const [companyRows, jobRows, replies, inbound, queue] = await Promise.all([
      this.prisma.company.findMany({ where: { id: { in: attempts.map((a) => a.companyId) } }, select: { id: true, name: true, careersUrl: true, website: true } }),
      this.prisma.job.findMany({ where: { id: { in: attempts.map((a) => a.jobId).filter((x): x is string => !!x) } }, select: { id: true, title: true, applyUrl: true, channel: true, listings: { select: { applyUrl: true, canonicalUrl: true } } } }),
      this.prisma.inboundMessage.groupBy({ by: ['attemptId'], where: { attemptId: { in: attemptIds } }, _count: true }),
      this.prisma.inboundMessage.findMany({ where: { attemptId: { in: attemptIds }, category: { not: null } }, orderBy: { receivedAt: 'asc' }, select: { attemptId: true, category: true, status: true, suggestedUrl: true } }),
      this.sending.queueSummary(ctx.workspaceId),
    ]);
    const companies = new Map(companyRows.map((c) => [c.id, c]));
    const jobs = new Map(jobRows.map((j) => [j.id, j]));
    const replyCount = new Map(replies.map((r) => [r.attemptId, r._count]));
    const deliveryOf = new Map(inbound.map((m) => [m.attemptId, m]));
    const requestedUrl = new Map(inbound.filter((m) => m.suggestedUrl).map((m) => [m.attemptId, m.suggestedUrl]));
    return {
      queue,
      items: attempts.map((a) => {
        const job = a.jobId ? jobs.get(a.jobId) : undefined;
        const company = companies.get(a.companyId);
        const delivery = deliveryOf.get(a.id);
        return {
          id: a.id,
          companyId: a.companyId,
          company: company?.name ?? '-',
          title: job?.title ?? null,
          formUrl: job && FORM_CHANNELS.includes(job.channel) ? job.applyUrl : null,
          state: a.state,
          stateReason: a.stateReason,
          reasonLabel: a.stateReason ? reasonLabelOf(a.stateReason) : null,
          scheduledAt: a.scheduledAt,
          outcome: a.outcome,
          viaForm: a.channel === 'platform',
          toEmail: a.toEmail,
          sentAt: a.acceptedAt ?? a.createdAt,
          replyCount: replyCount.get(a.id) ?? 0,
          delivery: delivery ? deliveryInfo(delivery) : null,
          retryOfId: a.retryOfId,
          retried: retried.has(a.id),
          links: mergeLinks([replyApplyLink(requestedUrl.get(a.id))], job ? jobApplyLinks(job) : [], company ? companyLinks(company) : []),
        };
      }),
    };
  }

  async application(ctx: RequestContext, id: string): Promise<ServerShape<HomeApplicationDetail>> {
    const detail = await this.applicationsService.getApplication(ctx, id);
    const documents = detail.revision?.documentIds.length
      ? await this.prisma.documentVersion.findMany({ where: { id: { in: detail.revision.documentIds } }, select: { id: true, label: true, fileName: true, type: true, mime: true, size: true, archived: true, candidateId: true, language: true, createdAt: true } })
      : [];
    const latest = documents.some((d) => d.archived)
      ? await this.prisma.documentVersion.findMany({ where: { candidateId: documents[0].candidateId, archived: false, scanState: 'clean' }, select: { id: true, label: true, fileName: true, type: true, mime: true, size: true, language: true, createdAt: true } })
      : [];
    const currentDocuments = documents
      .map(({ archived, candidateId: _candidateId, ...d }) => (archived ? (replacementFor(d, latest) ?? d) : d))
      .map(({ createdAt: _createdAt, ...d }) => d);
    return {
      id: detail.attempt.id,
      company: detail.company.name,
      title: detail.job?.title ?? null,
      state: detail.attempt.state,
      stateLabel: detail.stateLabel,
      outcome: detail.attempt.outcome,
      viaForm: detail.attempt.channel === 'platform',
      sentAt: detail.attempt.acceptedAt ?? detail.attempt.createdAt,
      fromEmail: detail.account?.accountEmail ?? null,
      toEmail: detail.attempt.toEmail ?? detail.revision?.toEmail ?? null,
      subject: detail.revision?.subject ?? null,
      body: detail.revision?.body ?? null,
      links: detail.revision?.links ?? [],
      documents: documents.map(({ archived: _archived, candidateId: _candidateId, ...d }) => d),
      currentDocuments,
      replies: detail.replies.map((r) => ({ id: r.id, fromEmail: r.fromEmail, subject: r.subject, snippet: r.snippet, classification: r.classification, receivedAt: r.receivedAt })),
    };
  }

  async markApplied(ctx: RequestContext, opportunityId: string) {
    const opp = await this.prisma.opportunity.findFirst({ where: { id: opportunityId, workspaceId: ctx.workspaceId }, include: { searchProfile: true } });
    if (!opp) throw notFound('Fırsat');
    let draft = await this.prisma.applicationDraft.findFirst({ where: { opportunityId, status: { in: EDITABLE_DRAFT_STATES } }, orderBy: { createdAt: 'desc' } });
    if (!draft) {
      draft = await this.drafting.create({
        workspaceId: ctx.workspaceId,
        candidateId: opp.searchProfile.candidateId,
        companyId: opp.companyId,
        jobId: opp.jobId,
        opportunityId,
        intentType: intentForOpportunity(opp),
        origin: 'manual',
        createdById: ctx.userId,
        useAi: false,
      });
    }
    await this.applicationsService.platformComplete(ctx, draft.id);
    return { ok: true };
  }

  async researchMissingEmails(ctx: RequestContext, force = false) {
    const { items } = await this.opportunities(ctx);
    const companyIds = [...new Set(items.filter((i) => !i.canEmail).map((i) => i.companyId))];
    const companies = await this.prisma.company.findMany({ where: { id: { in: companyIds }, workspaceId: ctx.workspaceId }, select: { id: true, researchMeta: true } });
    const stamp = Date.now();
    const due = companies.filter((c) => contactSearchPlan(c.researchMeta as ResearchMeta, { deep: true, force }, stamp).skip === null);
    const queued = due.slice(0, BULK_DETAILS_LIMIT);
    for (const c of queued) {
      await this.outbox.emit({ workspaceId: ctx.workspaceId, eventType: 'research.details.bulk', aggregateId: c.id, dedupKey: `research-details:${c.id}:bulk:${stamp}`, payload: { actorId: ctx.userId, force } });
    }
    return { queued: queued.length, companyIds: queued.map((c) => c.id), skippedRecent: companies.length - due.length, deferred: due.length - queued.length };
  }

  async lookupCompany(ctx: RequestContext, query: string) {
    const normalizedName = normalizeCompanyName(query);
    const existing = await this.prisma.company.findFirst({ where: { workspaceId: ctx.workspaceId, normalizedName }, select: { id: true, name: true, excluded: true } });
    if (existing && !existing.excluded) return { status: 'exists', companyId: existing.id, name: existing.name };
    const lookupId = randomToken(12);
    await this.outbox.emit({ workspaceId: ctx.workspaceId, eventType: 'company.lookup', aggregateId: lookupId, dedupKey: `company-lookup:${lookupId}`, payload: { query, actorId: ctx.userId } });
    return { status: 'pending', lookupId };
  }

  lookupStatus(ctx: RequestContext, lookupId: string) {
    return this.research.lookupStatus(ctx.workspaceId, lookupId);
  }

  /** Sıradaki başvurular iptal edilir; gönderilmiş olanlar yalnızca listeden gizlenir (30 günlük firma kuralı sürer). */
  async removeApplications(ctx: RequestContext, attemptIds: string[]) {
    const attempts = await this.prisma.applicationAttempt.findMany({ where: { id: { in: attemptIds }, workspaceId: ctx.workspaceId }, select: { id: true, state: true } });
    let cancelled = 0;
    for (const a of attempts.filter((x) => x.state === 'queued')) {
      if (await this.sending.cancel(ctx.workspaceId, a.id, 'USER_REMOVED', ctx.userId)) cancelled++;
    }
    await this.prisma.applicationAttempt.updateMany({ where: { id: { in: attempts.map((a) => a.id) } }, data: { hiddenAt: new Date() } });
    return { removed: attempts.length, cancelled };
  }

  retryApplications(ctx: RequestContext, attemptIds?: string[]) {
    return this.sending.retryQueued(ctx.workspaceId, attemptIds);
  }

  async setMailLimit(ctx: RequestContext, dailyLimit: number) {
    const { candidate } = await this.primary(ctx.workspaceId);
    if (!candidate) throw new AppError(422, 'PROFILE_MISSING', 'Önce profilini oluştur');
    await this.prisma.mailAccount.updateMany({ where: { workspaceId: ctx.workspaceId, candidateId: candidate.id }, data: { dailyLimit } });
    return this.state(ctx);
  }

  async translateDraft(ctx: RequestContext, draftId: string, lang: 'en' | 'tr') {
    const draft = await this.prisma.applicationDraft.findFirst({ where: { id: draftId, workspaceId: ctx.workspaceId } });
    if (!draft) throw notFound('Taslak');
    if (!EDITABLE_DRAFT_STATES.includes(draft.status)) throw new AppError(409, 'DRAFT_NOT_EDITABLE', 'Gönderilmiş başvuru çevrilemez');
    await this.outbox.emit({ workspaceId: ctx.workspaceId, eventType: 'draft.translate', aggregateId: draft.id, dedupKey: `draft-translate:${draft.id}:${lang}:${Date.now()}`, payload: { lang, userId: ctx.userId } });
    return { queued: true, revision: draft.currentRevision };
  }

  async researchDetails(ctx: RequestContext, companyId: string) {
    const company = await this.prisma.company.findFirst({ where: { id: companyId, workspaceId: ctx.workspaceId }, select: { id: true } });
    if (!company) throw notFound('Firma');
    await this.outbox.emit({ workspaceId: ctx.workspaceId, eventType: 'research.details', aggregateId: companyId, dedupKey: `research-details:${companyId}:${Date.now()}`, payload: { actorId: ctx.userId } });
    return { queued: true };
  }

  async undoApplied(ctx: RequestContext, attemptId: string) {
    const attempt = await this.prisma.applicationAttempt.findFirst({ where: { id: attemptId, workspaceId: ctx.workspaceId } });
    if (!attempt) throw notFound('Başvuru');
    if (attempt.channel !== 'platform') throw new AppError(409, 'CANNOT_UNDO', 'Mail ile gönderilmiş bir başvuru geri alınamaz');
    const draft = await this.prisma.applicationDraft.findUnique({ where: { id: attempt.draftId } });
    await this.prisma.$transaction([
      this.prisma.applicationAttempt.update({ where: { id: attempt.id }, data: { state: 'cancelled', activeKey: null, stateReason: 'Kullanıcı "Başvurdum" işaretini geri aldı' } }),
      this.prisma.applicationDraft.update({ where: { id: attempt.draftId }, data: { status: 'draft' } }),
      ...(draft?.opportunityId ? [this.prisma.opportunity.update({ where: { id: draft.opportunityId }, data: { status: 'drafted' } })] : []),
    ]);
    return { ok: true };
  }

  async prepare(ctx: RequestContext, ids: string[]) {
    const owned = await this.prisma.opportunity.findMany({ where: { id: { in: ids }, workspaceId: ctx.workspaceId }, select: { id: true } });
    const existing = await this.prisma.applicationDraft.findMany({ where: { opportunityId: { in: owned.map((o) => o.id) }, status: { in: ACTIVE_DRAFT_STATES } }, select: { opportunityId: true } });
    const ready = new Set(existing.map((d) => d.opportunityId));
    const stamp = Date.now();
    for (const o of owned.filter((o) => !ready.has(o.id))) {
      await this.outbox.emit({ workspaceId: ctx.workspaceId, eventType: 'home.prepare', aggregateId: o.id, dedupKey: `home-prepare:${o.id}:${stamp}`, payload: { userId: ctx.userId } });
    }
    return { preparing: owned.length - ready.size, ready: ready.size };
  }

  async preview(ctx: RequestContext, opportunityId: string): Promise<ServerShape<HomePreview>> {
    const opp = await this.prisma.opportunity.findFirst({
      where: { id: opportunityId, workspaceId: ctx.workspaceId },
      include: { company: { select: { id: true, name: true, groupName: true, canonicalDomain: true, aliases: true, contacts: true } }, job: { select: { title: true, applyUrl: true, applyEmail: true } } },
    });
    if (!opp) throw notFound('Fırsat');
    const scoring = { domain: opp.company.canonicalDomain, aliases: opp.company.aliases, delivery: await this.models.deliveryFor(opp.company) };
    const suggestedTo = opp.job?.applyEmail ?? pickContact(opp.company.contacts, scoring)?.email ?? null;
    const header = {
      opportunityId,
      companyId: opp.company.id,
      company: opp.company.name,
      title: opp.job?.title ?? null,
      applyUrl: opp.job?.applyUrl ?? null,
      suggestedTo,
      recipientOptions: recipientOptionsOf(opp.job?.applyEmail, opp.company.contacts, scoring),
      groupSuggestion: suggestedTo ? null : groupSuggestionOf(opp.company),
      recipientSuggestions: suggestedTo ? [] : recipientSuggestionsOf(opp.company),
    };
    let draft = await this.prisma.applicationDraft.findFirst({ where: { opportunityId, status: { in: ACTIVE_DRAFT_STATES } }, orderBy: { createdAt: 'desc' } });
    if (draft && draft.currentRevision > 0 && suggestedTo && EDITABLE_DRAFT_STATES.includes(draft.status)) draft = await this.automation.fillMissingRecipient(draft, suggestedTo, ctx.userId);
    const rev = draft && draft.currentRevision > 0 ? await this.prisma.draftRevision.findUnique({ where: { draftId_revision: { draftId: draft.id, revision: draft.currentRevision } } }) : null;
    if (!draft || !rev) return { ...header, status: 'preparing' as const, draft: null };
    const documentSelect = { id: true, label: true, fileName: true, type: true, mime: true, size: true, language: true, createdAt: true };
    const [account, documents, availableDocuments] = await Promise.all([
      draft.mailAccountId ? this.prisma.mailAccount.findUnique({ where: { id: draft.mailAccountId }, select: { accountEmail: true } }) : null,
      rev.documentIds.length ? this.prisma.documentVersion.findMany({ where: { id: { in: rev.documentIds } }, select: documentSelect }) : [],
      this.prisma.documentVersion.findMany({ where: { candidateId: draft.candidateId, archived: false, scanState: 'clean' }, orderBy: { createdAt: 'desc' }, select: documentSelect }),
    ]);
    return {
      ...header,
      status: ['queued', 'sent'].includes(draft.status) ? ('sent' as const) : ('ready' as const),
      draft: {
        id: draft.id,
        status: draft.status,
        revision: draft.currentRevision,
        fromEmail: account?.accountEmail ?? null,
        toEmail: rev.toEmail ?? null,
        subject: rev.subject,
        body: rev.body,
        links: rev.links,
        documents,
        availableDocuments,
        problems: draft.blockedReasons,
      },
    };
  }

  async redraft(ctx: RequestContext, opportunityId: string) {
    const opp = await this.prisma.opportunity.findFirst({ where: { id: opportunityId, workspaceId: ctx.workspaceId }, select: { id: true } });
    if (!opp) throw notFound('Fırsat');
    await this.prisma.applicationDraft.updateMany({ where: { opportunityId, status: { in: EDITABLE_DRAFT_STATES } }, data: { status: 'cancelled' } });
    await this.outbox.emit({ workspaceId: ctx.workspaceId, eventType: 'home.prepare', aggregateId: opportunityId, dedupKey: `home-redraft:${opportunityId}:${Date.now()}`, payload: { userId: ctx.userId, fresh: true } });
    return { ok: true };
  }

  async letters(ctx: RequestContext): Promise<HomeLetters> {
    const { candidate } = await this.primary(ctx.workspaceId);
    const saved = candidate ? await this.letterService.templates(candidate.id) : {};
    return {
      placeholders: LETTER_PLACEHOLDERS,
      example: candidate ? await this.letterService.candidateExample(candidate.id) : null,
      templates: LETTER_INTENTS.map((intent) => ({ intent, label: INTENT_LABELS[intent], ...(saved[intent] ?? { body: null, source: null, updatedAt: null }) })),
    };
  }

  async saveLetterExample(ctx: RequestContext, text: string | null) {
    const { candidate } = await this.primary(ctx.workspaceId);
    if (!candidate) throw new AppError(422, 'PROFILE_MISSING', 'Önce profilini oluştur');
    const saved = await this.letterService.saveCandidateExample(candidate.id, text);
    const stamp = Date.now();
    for (const intent of LETTER_INTENTS) {
      await this.outbox.emit({ workspaceId: ctx.workspaceId, eventType: 'letters.generate', aggregateId: candidate.id, dedupKey: `letters:${candidate.id}:${intent}:example:${stamp}`, payload: { intent, userId: ctx.userId } });
    }
    return saved;
  }

  async saveLetter(ctx: RequestContext, intent: string, body: string) {
    const { candidate } = await this.primary(ctx.workspaceId);
    if (!candidate) throw new AppError(422, 'PROFILE_MISSING', 'Önce profilini oluştur');
    if (!isLetterIntent(intent)) throw new AppError(400, 'INTENT_UNKNOWN', 'Bilinmeyen yazı türü');
    if (!body.includes('{firma}')) throw new AppError(422, 'PLACEHOLDER_MISSING', 'Kalıpta en azından {firma} yer tutucusu olmalı');
    return this.letterService.saveTemplate(candidate.id, intent, body, 'user');
  }

  async regenerateLetter(ctx: RequestContext, intent: string) {
    const { candidate } = await this.primary(ctx.workspaceId);
    if (!candidate) throw new AppError(422, 'PROFILE_MISSING', 'Önce profilini oluştur');
    if (!isLetterIntent(intent)) throw new AppError(400, 'INTENT_UNKNOWN', 'Bilinmeyen yazı türü');
    await this.outbox.emit({ workspaceId: ctx.workspaceId, eventType: 'letters.generate', aggregateId: candidate.id, dedupKey: `letters:${candidate.id}:${intent}:${Date.now()}`, payload: { intent, userId: ctx.userId } });
    return { queued: true };
  }

  async apply(ctx: RequestContext, ids: string[]) {
    const owned = await this.prisma.opportunity.findMany({ where: { id: { in: ids }, workspaceId: ctx.workspaceId }, select: { id: true } });
    const stamp = Date.now();
    for (const o of owned) {
      await this.outbox.emit({ workspaceId: ctx.workspaceId, eventType: 'home.apply', aggregateId: o.id, dedupKey: `home-apply:${o.id}:${stamp}`, payload: { userId: ctx.userId } });
    }
    return { queued: owned.length };
  }
}

function distinctCities(cities: (string | null)[]) {
  const seen = new Map<string, string>();
  for (const city of cities) {
    const name = city?.trim();
    if (name && !seen.has(name.toLocaleLowerCase('tr'))) seen.set(name.toLocaleLowerCase('tr'), name);
  }
  return [...seen.values()];
}

function reasonLabelOf(reason: string) {
  if (reason.startsWith('INBOUND:')) return INBOUND_LABELS[reason.slice(8) as InboundCategory] ?? 'Mail geri döndü';
  return ATTEMPT_REASON_LABELS[reason] ?? reason;
}

function deliveryInfo(m: { category: string | null; status: string }) {
  const category = (m.category ?? 'unknown') as InboundCategory;
  return { category, label: INBOUND_LABELS[category], group: INBOUND_GROUP[category], status: m.status };
}

type ResearchReport = { summary?: string | null; roleNeedInference?: { text?: string | null } | null; applicationAngle?: string | null } | null;

function recipientSuggestionsOf(company: { groupName: string | null; contacts: { kind: string; email: string; suppressed?: boolean; sourceUrl?: string | null; ownershipEvidence?: string | null }[] }) {
  return company.contacts
    .filter((c) => SUGGESTED_ONLY_KINDS.includes(c.kind) && !c.suppressed)
    .sort((a, b) => Number(a.kind === CANDIDATE_HR_KIND) - Number(b.kind === CANDIDATE_HR_KIND))
    .map((c) => {
      const owner = c.ownershipEvidence?.replace(/^Grup:\s*/, '') || company.groupName;
      const stale = c.kind === CANDIDATE_HR_KIND;
      return {
        email: c.email,
        kind: c.kind,
        groupName: owner,
        sourceUrl: c.sourceUrl ?? null,
        label: stale ? (classifyPublishedEmail(c.email).kind === 'general' ? 'Genel iletişim adresi (üçüncü taraf kaynak)' : 'İK adresi (eski paylaşım veya üçüncü taraf kaynak)') : `${owner ?? 'Bağlı olduğu grup'} İK adresi`,
        note: stale ? 'Güncelliği doğrulanamadı; kullanmadan önce kontrol et.' : 'Bu adres firmaya değil gruba gider.',
      };
    });
}

function groupSuggestionOf(company: Parameters<typeof recipientSuggestionsOf>[0]) {
  return recipientSuggestionsOf(company)[0] ?? null;
}

function analysisOf(report: unknown) {
  const r = report as ResearchReport;
  if (!r?.summary && !r?.roleNeedInference?.text && !r?.applicationAngle) return null;
  return { summary: r.summary ?? null, potential: r.roleNeedInference?.text ?? null, approach: r.applicationAngle ?? null };
}

function fitLabel(category: string, f: number | null): 'strong' | 'good' | 'check' {
  if (category === 'needs_confirmation') return 'check';
  if (category === 'target_open' && (f ?? 0) >= STRONG_FIT_SCORE) return 'strong';
  return 'good';
}

function summarize(o: { category: string; titleMatch: string; locationState: string; job: { locationText: string | null; firstSeenAt: Date } | null }): string {
  const parts: string[] = [];
  if (o.category === 'past_closed') parts.push('İlan kapanmış; firma benzer rolü yeniden açabilir');
  else if (o.titleMatch === 'exact') parts.push('Aradığın pozisyonla birebir eşleşiyor');
  else if (o.titleMatch === 'adjacent' || o.category === 'adjacent_open') parts.push('Aradığın pozisyona yakın bir rol');
  else if (o.category === 'needs_confirmation') parts.push(o.job ? 'İlanın hâlâ açık olduğu teyit edilmeli' : 'Kariyer sayfasına erişilemedi; ilgili ilanı olup olmadığı bilinmiyor');
  else if (o.category === USER_SELECTED_CATEGORY) parts.push('Firmanın diğer ilanlarından sen seçtin');
  else if (o.category === 'sector_target') parts.push('Şu an ilanı yok; pozisyon açma potansiyeli olan firma');
  else if (o.category === 'not_found') parts.push('Kariyer sayfası tarandı, şu an uygun ilan yok');
  const where: Record<string, string> = { primary: o.job?.locationText ?? 'Tercih ettiğin şehirde', conditional: 'Yakın bölgede', remote: 'Uzaktan çalışma', outside: 'Tercih ettiğin bölgenin dışında', unknown: 'Konum belirtilmemiş' };
  parts.push(where[o.locationState] ?? where.unknown);
  if (o.job?.firstSeenAt) {
    const days = Math.floor((Date.now() - o.job.firstSeenAt.getTime()) / 86_400_000);
    parts.push(days <= 0 ? 'bugün bulundu' : `${days} gün önce bulundu`);
  }
  return parts.join(' · ');
}

@Controller('v1/home')
export class HomeController {
  constructor(
    private readonly svc: HomeService,
    private readonly inbox: InboxService,
    private readonly autopilot: AutopilotService,
  ) {}

  @Get('inbox')
  async inboxList(@Ctx() ctx: RequestContext): Promise<ServerShape<HomeInboxWithAutopilot>> {
    const [inbox, autopilot] = await Promise.all([this.inbox.list(ctx.workspaceId), this.autopilot.overview(ctx.workspaceId)]);
    return { ...inbox, autopilot };
  }

  @Post('inbox/sync')
  inboxSync(@Ctx() ctx: RequestContext) {
    return this.inbox.requestSync(ctx.workspaceId);
  }

  @Post('inbox/status')
  inboxStatus(@Ctx() ctx: RequestContext, @Body(new ZodPipe(inboxStatusSchema)) body: z.infer<typeof inboxStatusSchema>) {
    return this.inbox.setStatus(ctx.workspaceId, body.ids, body.status);
  }

  @Post('autopilot/approve')
  autopilotApprove(@Ctx() ctx: RequestContext, @Body(new ZodPipe(autopilotIdsSchema)) body: z.infer<typeof autopilotIdsSchema>) {
    return this.autopilot.approve(ctx.workspaceId, ctx.userId, body.ids);
  }

  @Post('autopilot/dismiss')
  autopilotDismiss(@Ctx() ctx: RequestContext, @Body(new ZodPipe(autopilotIdsSchema)) body: z.infer<typeof autopilotIdsSchema>) {
    return this.autopilot.dismiss(ctx.workspaceId, body.ids);
  }

  @Put('inbox/settings')
  inboxSettings(@Ctx() ctx: RequestContext, @Body(new ZodPipe(inboxSettingsSchema)) body: z.infer<typeof inboxSettingsSchema>) {
    return this.inbox.setEnabled(ctx.workspaceId, body.enabled);
  }

  @Get('inbox/:id')
  inboxDetail(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.inbox.detail(ctx.workspaceId, id);
  }

  @Post('applications/resend')
  resendMany(@Ctx() ctx: RequestContext, @Body(new ZodPipe(resendManySchema)) body: z.infer<typeof resendManySchema>) {
    return this.inbox.resendMany(ctx.workspaceId, ctx.userId, body.ids);
  }

  @Post('applications/:id/resend')
  resend(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new ZodPipe(resendSchema)) body: z.infer<typeof resendSchema>) {
    return this.inbox.resend(ctx.workspaceId, ctx.userId, id, body);
  }

  @Get()
  state(@Ctx() ctx: RequestContext) {
    return this.svc.state(ctx);
  }

  @Put('profile')
  profile(@Ctx() ctx: RequestContext, @Body(new ZodPipe(profileSchema)) body: z.infer<typeof profileSchema>) {
    return this.svc.saveProfile(ctx, body);
  }

  @Post('search')
  search(@Ctx() ctx: RequestContext) {
    return this.svc.search(ctx);
  }

  @Post('search/stop')
  stopSearch(@Ctx() ctx: RequestContext) {
    return this.svc.stopSearch(ctx);
  }

  @Post('search/targeted')
  targetedSearch(@Ctx() ctx: RequestContext, @Body(new ZodPipe(targetedSearchSchema)) body: z.infer<typeof targetedSearchSchema>) {
    return this.svc.targetedSearch(ctx, body.query);
  }

  @Post('auto-apply')
  autoApply(@Ctx() ctx: RequestContext, @Body(new ZodPipe(autoApplySchema)) body: z.infer<typeof autoApplySchema>) {
    return this.svc.setAutoApply(ctx, body.enabled);
  }

  @Post('sync')
  async sync(@Ctx() ctx: RequestContext) {
    const r = await this.svc.syncPolicy(ctx);
    return { ...(await this.svc.state(ctx)), policyBlocker: r.blocker };
  }

  @Get('opportunities')
  opportunities(@Ctx() ctx: RequestContext) {
    return this.svc.opportunities(ctx);
  }

  @Get('companies')
  companies(@Ctx() ctx: RequestContext) {
    return this.svc.companies(ctx);
  }

  @Get('applications')
  applications(@Ctx() ctx: RequestContext) {
    return this.svc.applications(ctx);
  }

  @Get('applications/:id')
  application(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.svc.application(ctx, id);
  }

  @Post('companies/sizes')
  researchSizes(@Ctx() ctx: RequestContext) {
    return this.svc.researchSizes(ctx);
  }

  @Post('companies/missing-emails')
  researchMissingEmails(@Ctx() ctx: RequestContext, @Body(new ZodPipe(missingEmailsSchema)) body: z.infer<typeof missingEmailsSchema>) {
    return this.svc.researchMissingEmails(ctx, body.force);
  }

  @Post('applications/remove')
  removeApplications(@Ctx() ctx: RequestContext, @Body(new ZodPipe(removeSchema)) body: z.infer<typeof removeSchema>) {
    return this.svc.removeApplications(ctx, body.ids);
  }

  @Post('applications/retry')
  retryApplications(@Ctx() ctx: RequestContext, @Body(new ZodPipe(retrySchema)) body: z.infer<typeof retrySchema>) {
    return this.svc.retryApplications(ctx, body.ids);
  }

  @Put('mail-limit')
  setMailLimit(@Ctx() ctx: RequestContext, @Body(new ZodPipe(mailLimitSchema)) body: z.infer<typeof mailLimitSchema>) {
    return this.svc.setMailLimit(ctx, body.dailyLimit);
  }

  @Post('companies/lookup')
  lookupCompany(@Ctx() ctx: RequestContext, @Body(new ZodPipe(lookupSchema)) body: z.infer<typeof lookupSchema>) {
    return this.svc.lookupCompany(ctx, body.name);
  }

  @Get('companies/lookup/:id')
  lookupStatus(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.svc.lookupStatus(ctx, id);
  }

  @Post('drafts/:id/translate')
  translateDraft(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new ZodPipe(translateSchema)) body: z.infer<typeof translateSchema>) {
    return this.svc.translateDraft(ctx, id, body.lang);
  }

  @Post('companies/:id/details')
  researchDetails(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.svc.researchDetails(ctx, id);
  }

  @Post('applications/:id/undo')
  undoApplied(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.svc.undoApplied(ctx, id);
  }

  @Post('mark-applied')
  markApplied(@Ctx() ctx: RequestContext, @Body(new ZodPipe(markAppliedSchema)) body: z.infer<typeof markAppliedSchema>) {
    return this.svc.markApplied(ctx, body.opportunityId);
  }

  @Post('prepare')
  prepare(@Ctx() ctx: RequestContext, @Body(new ZodPipe(applySchema)) body: z.infer<typeof applySchema>) {
    return this.svc.prepare(ctx, body.opportunityIds);
  }

  @Post('redraft')
  redraft(@Ctx() ctx: RequestContext, @Body(new ZodPipe(markAppliedSchema)) body: z.infer<typeof markAppliedSchema>) {
    return this.svc.redraft(ctx, body.opportunityId);
  }

  @Get('preview/:opportunityId')
  preview(@Ctx() ctx: RequestContext, @Param('opportunityId') opportunityId: string) {
    return this.svc.preview(ctx, opportunityId);
  }

  @Get('letters')
  letters(@Ctx() ctx: RequestContext) {
    return this.svc.letters(ctx);
  }

  @Put('letter-example')
  saveLetterExample(@Ctx() ctx: RequestContext, @Body(new ZodPipe(letterExampleSchema)) body: z.infer<typeof letterExampleSchema>) {
    return this.svc.saveLetterExample(ctx, body.text);
  }

  @Put('letters/:intent')
  saveLetter(@Ctx() ctx: RequestContext, @Param('intent') intent: string, @Body(new ZodPipe(letterSchema)) body: z.infer<typeof letterSchema>) {
    return this.svc.saveLetter(ctx, intent, body.body);
  }

  @Post('letters/:intent/regenerate')
  regenerateLetter(@Ctx() ctx: RequestContext, @Param('intent') intent: string) {
    return this.svc.regenerateLetter(ctx, intent);
  }

  @Post('apply')
  apply(@Ctx() ctx: RequestContext, @Body(new ZodPipe(applySchema)) body: z.infer<typeof applySchema>) {
    return this.svc.apply(ctx, body.opportunityIds);
  }
}

@Controller('v1/admin')
export class AdminController {
  constructor(
    private readonly ai: AiService,
    private readonly letters: LetterService,
    private readonly prisma: PrismaService,
    private readonly models: LearnedModelsService,
  ) {}

  @AdminOnly()
  @Get('learning')
  learning() {
    return this.models.overview();
  }

  @AdminOnly()
  @Post('learning/train')
  async trainModels() {
    await this.models.train();
    return this.models.overview();
  }

  /** İnce ayara hazır veri seti; istemler aday ve firma bilgisi içerdiği için yalnızca yönetici indirebilir. */
  @AdminOnly()
  @Get('learning/export')
  async exportLearning(@Res() res: Response) {
    const data = await this.models.exportDataset();
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="jobless-turtle-veri-seti-${new Date().toISOString().slice(0, 10)}.jsonl"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(data);
  }

  @AdminOnly()
  @Get('ai-usage')
  async aiUsage() {
    const since = new Date(Date.now() - 24 * 3_600_000);
    const rows = await this.prisma.aiTask.groupBy({
      by: ['kind', 'provider', 'model'],
      where: { createdAt: { gte: since }, provider: { notIn: ['manual', 'template'] } },
      _count: true,
      _sum: { inputTokens: true, outputTokens: true, cacheReadTokens: true, cacheWriteTokens: true, costUsd: true },
      _avg: { durationMs: true },
    });
    return {
      since,
      cooldowns: await this.ai.cooldowns(),
      rows: rows
        .map((r) => ({
          kind: r.kind,
          kindLabel: AI_KIND_LABELS[r.kind as keyof typeof AI_KIND_LABELS] ?? r.kind,
          provider: r.provider,
          model: r.model,
          count: r._count,
          inputTokens: r._sum.inputTokens ?? 0,
          outputTokens: r._sum.outputTokens ?? 0,
          cacheReadTokens: r._sum.cacheReadTokens ?? 0,
          cacheWriteTokens: r._sum.cacheWriteTokens ?? 0,
          costUsd: r._sum.costUsd ?? 0,
          avgSeconds: Math.round((r._avg.durationMs ?? 0) / 1000),
        }))
        .sort((a, b) => b.costUsd - a.costUsd || b.count - a.count),
    };
  }

  @AdminOnly()
  @Get('letter-style')
  async letterStyle() {
    return { text: await this.letters.styleExample(), guide: await this.letters.guide() };
  }

  @AdminOnly()
  @Put('letter-guide')
  saveLetterGuide(@Body(new ZodPipe(letterGuideSchema)) body: z.infer<typeof letterGuideSchema>) {
    return this.letters.saveGuide(body.text);
  }

  @AdminOnly()
  @Put('letter-style')
  saveLetterStyle(@Body(new ZodPipe(letterStyleSchema)) body: z.infer<typeof letterStyleSchema>) {
    return this.letters.saveStyleExample(body.text);
  }

  @AdminOnly()
  @Get('settings')
  settings() {
    return this.ai.serverSettings();
  }

  @AdminOnly()
  @Patch('settings')
  update(@Body(new ZodPipe(serverSettingsSchema)) body: z.infer<typeof serverSettingsSchema>) {
    return this.ai.updateServerSettings(body);
  }
}

@Module({ imports: [CandidatesModule, ApplicationsModule], controllers: [HomeController, AdminController], providers: [HomeService] })
export class HomeModule {}
