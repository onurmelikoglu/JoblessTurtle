import { Body, Controller, Get, Injectable, Put } from '@nestjs/common';
import { AutomationPolicy, Prisma } from '@prisma/client';
import { z } from 'zod';
import { AuditService } from '../../common/audit.service';
import { Ctx, RequestContext } from '../../common/auth';
import { AppError } from '../../common/errors';
import { OutboxService } from '../../common/outbox.service';
import { PrismaService } from '../../common/prisma.service';
import { istanbulDay } from '../../common/time';
import { UsageService } from '../../common/usage.service';
import { ZodPipe } from '../../common/zod.pipe';
import type { AutoApplyExplain, AutoApplySettings, AutoApplyView, AutoWorkMode } from '../../contracts/auto-apply';
import { ServerShape } from '../../contracts/wire';
import { ATS_REWRITE_MODES, DEFAULT_ATS_REWRITE_MODE, DEFAULT_ATS_THRESHOLD, MAX_ATS_THRESHOLD, MIN_ATS_THRESHOLD } from '../../domain/ats';
import { EMPLOYEE_RANGES, EmployeeRange } from '../../domain/company-size';
import { CV_LAYOUT_MODES, CvLayoutMode, DEFAULT_CV_LAYOUT_MODE } from '../../domain/cv-layout';
import { CvMaxPages, DEFAULT_CV_MAX_PAGES } from '../../domain/cv-fit';
import { citySelectionsOf } from '../../domain/geo';
import { SEARCH_INTERVAL_HOURS } from '../../domain/job-search';
import { REASON_LABELS, ReasonCode } from '../../domain/policy';
import { provinceNames } from '../../domain/provinces';
import { SCRAPER_SOURCES } from '../../domain/scraper-config';
import { AiService } from '../../engine/ai/ai.service';
import { ScraperService } from '../../engine/scraper.service';

const WORK_MODES = ['onsite', 'hybrid', 'remote'] as const;
const OPEN_TARGET = { category: { in: ['target_open', 'adjacent_open'] }, status: { notIn: ['dismissed', 'applied'] } };
const EXPLAIN_DAYS = 7;
const MAX_FILTER_CITIES = 30;
const MAX_COOLDOWN_DAYS = 180;

export const autoApplySettingsSchema = z.object({
  dailyLimit: z.number().int().min(1).max(100),
  searchEveryHours: z.number().int().refine((h) => (SEARCH_INTERVAL_HOURS as readonly number[]).includes(h), 'Geçersiz arama aralığı'),
  filterCities: z.array(z.string().trim().min(2).max(60)).max(MAX_FILTER_CITIES),
  filterWorkModes: z.array(z.enum(WORK_MODES)),
  filterSizes: z.array(z.enum(EMPLOYEE_RANGES)),
  includeUnknownWorkMode: z.boolean(),
  includeUnknownSize: z.boolean(),
  fMin: z.number().min(0).max(100),
  qMin: z.number().min(0).max(100),
  coverageMin: z.number().min(0).max(1),
  companyCooldownDays: z.number().int().min(0).max(MAX_COOLDOWN_DAYS),
  atsAutoImprove: z.boolean(),
  atsThreshold: z.number().int().min(MIN_ATS_THRESHOLD).max(MAX_ATS_THRESHOLD),
  atsRewriteMode: z.enum(ATS_REWRITE_MODES),
  atsCvLayout: z.enum(CV_LAYOUT_MODES).optional(),
  atsMaxPages: z.union([z.literal(1), z.literal(2)]).optional(),
});
type SettingsInput = z.infer<typeof autoApplySettingsSchema>;

/** Politikadaki kullanıcı ayarlarından okunur kurallar; "neye göre başvuruyor" özetinin başı. */
export function describeRules(p: AutomationPolicy, ats: { threshold: number; autoImprove: boolean }): string[] {
  const rules = [
    p.includeAdjacent ? 'Başlığı aradığın unvanlarla tam ya da yakın eşleşen açık ilanlar' : 'Başlığı aradığın unvanlarla tam eşleşen açık ilanlar',
    `Rol uyumu (F) en az ${p.fMin}${p.qMin > 0 ? `, firma kalitesi (Q) en az ${p.qMin}` : ''}${p.coverageMin > 0 ? `, firma bilgisi kapsamı en az %${Math.round(p.coverageMin * 100)}` : ''}`,
    'Alıcı: doğrulanmış İK ya da ilandaki başvuru adresi',
    p.filterCities.length ? `Şehir: ${p.filterCities.join(', ')} (uzaktan ilanlar dahil)` : 'Şehir: profildeki bölgelerin; konumu belirsiz ilanlar incelemeye düşer',
  ];
  if (p.filterWorkModes.length) rules.push(`Çalışma şekli: ${p.filterWorkModes.map((m) => WORK_MODE_TEXT[m as AutoWorkMode] ?? m).join(', ')}${p.includeUnknownWorkMode ? ' (belirtilmemişler dahil)' : ''}`);
  if (p.filterSizes.length) rules.push(`Çalışan sayısı: ${p.filterSizes.join(', ')}${p.includeUnknownSize ? ' (bilinmeyenler dahil)' : ''}`);
  rules.push(`Gün içinde ${p.sendWindowStart}–${p.sendWindowEnd}, ${p.sendDays.length === 5 && p.sendDays.every((d, i) => d === i + 1) ? 'Pzt–Cum' : `${p.sendDays.length} gün`}; günde en çok ${p.dailyLimit} başvuru, aynı firmaya ${p.companyCooldownDays} gün arayla`);
  rules.push(ats.autoImprove ? `CV'nin ATS oranı %${ats.threshold} altındaysa gönderimden önce ilana göre iyileştirilir` : 'CV olduğu gibi gönderilir (ATS iyileştirme kapalı)');
  rules.push(`İlan araması ${p.searchEveryHours} saatte bir`);
  return rules;
}

const WORK_MODE_TEXT: Record<AutoWorkMode, string> = { onsite: 'yerinde', hybrid: 'hibrit', remote: 'uzaktan' };

@Injectable()
export class AutoApplyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly ai: AiService,
    private readonly usage: UsageService,
    private readonly scraper: ScraperService,
    private readonly audit: AuditService,
  ) {}

  private policyOf(workspaceId: string) {
    return this.prisma.automationPolicy.findFirst({ where: { workspaceId }, orderBy: [{ active: 'desc' }, { createdAt: 'desc' }] });
  }

  private async atsSettings(workspaceId: string) {
    const ai = await this.ai.settings(workspaceId);
    return { threshold: ai.atsThreshold ?? DEFAULT_ATS_THRESHOLD, rewriteMode: ai.atsRewriteMode ?? DEFAULT_ATS_REWRITE_MODE, cvLayout: ai.atsCvLayout ?? DEFAULT_CV_LAYOUT_MODE, maxPages: ai.atsMaxPages ?? DEFAULT_CV_MAX_PAGES };
  }

  private settingsOf(p: AutomationPolicy, ats: { threshold: number; rewriteMode: 'fill_gaps' | 'evidence_only'; cvLayout: CvLayoutMode; maxPages: CvMaxPages }): AutoApplySettings {
    return {
      autoSend: p.autoSend,
      dailyLimit: p.dailyLimit,
      searchEveryHours: p.searchEveryHours,
      filterCities: p.filterCities,
      filterWorkModes: p.filterWorkModes.filter((m): m is AutoWorkMode => (WORK_MODES as readonly string[]).includes(m)),
      filterSizes: p.filterSizes.filter((s): s is EmployeeRange => (EMPLOYEE_RANGES as readonly string[]).includes(s)),
      includeUnknownWorkMode: p.includeUnknownWorkMode,
      includeUnknownSize: p.includeUnknownSize,
      fMin: p.fMin,
      qMin: p.qMin,
      coverageMin: p.coverageMin,
      companyCooldownDays: p.companyCooldownDays,
      atsAutoImprove: p.atsAutoImprove,
      atsThreshold: ats.threshold,
      atsRewriteMode: ats.rewriteMode,
      atsCvLayout: ats.cvLayout,
      atsMaxPages: ats.maxPages,
    };
  }

  async view(ctx: RequestContext): Promise<ServerShape<AutoApplyView>> {
    const [policy, ats, candidate, scraperConfig] = await Promise.all([
      this.policyOf(ctx.workspaceId),
      this.atsSettings(ctx.workspaceId),
      this.prisma.candidateProfile.findFirst({ where: { workspaceId: ctx.workspaceId }, orderBy: { createdAt: 'asc' }, select: { city: true } }),
      ctx.isAdmin ? this.scraper.config() : Promise.resolve(null),
    ]);
    const options = {
      profileCities: citySelectionsOf(candidate?.city),
      provinces: provinceNames(),
      employeeRanges: [...EMPLOYEE_RANGES],
      searchIntervals: [...SEARCH_INTERVAL_HOURS],
      canSetScraperInterval: ctx.isAdmin,
      scraperIntervalHours: scraperConfig ? Math.min(...SCRAPER_SOURCES.filter((s) => scraperConfig.sources[s].enabled).map((s) => scraperConfig.sources[s].interval_hours)) : null,
    };
    if (!policy) return { settings: null, blocker: 'Otomatik başvuru için önce profil, aranan pozisyonlar, mail hesabı ve CV kaydedilmeli', options, explain: null };
    return { settings: this.settingsOf(policy, ats), blocker: null, options, explain: await this.explain(policy, ats) };
  }

  async explain(policy: AutomationPolicy, ats: { threshold: number }, now = new Date()): Promise<ServerShape<AutoApplyExplain>> {
    const since = new Date(now.getTime() - EXPLAIN_DAYS * 86400_000);
    const scope = { workspaceId: policy.workspaceId, searchProfileId: policy.searchProfileId };
    const [evaluated, open, sentToday, queued] = await Promise.all([
      this.prisma.opportunity.findMany({ where: { ...scope, autoEvaluatedAt: { gte: since } }, select: { autoReasons: true } }),
      this.prisma.opportunity.findMany({ where: { ...scope, ...OPEN_TARGET, job: { status: 'open' } }, select: { f: true, q: true, coverage: true } }),
      this.usage.get(policy.workspaceId, `auto:${policy.id}:job`, now),
      this.prisma.applicationAttempt.count({ where: { workspaceId: policy.workspaceId, sendMode: 'auto', state: 'queued' } }),
    ]);
    const counts = new Map<ReasonCode, number>();
    for (const o of evaluated) for (const code of (o.autoReasons as ReasonCode[] | null) ?? []) counts.set(code, (counts.get(code) ?? 0) + 1);
    const passF = (o: { f: number | null }) => o.f !== null && o.f >= policy.fMin;
    const passQ = (o: { q: number | null }) => policy.qMin <= 0 || (o.q !== null && o.q >= policy.qMin);
    const passCoverage = (o: { coverage: number | null }) => policy.coverageMin <= 0 || (o.coverage !== null && o.coverage >= policy.coverageMin);
    return {
      rules: describeRules(policy, { threshold: ats.threshold, autoImprove: policy.atsAutoImprove }),
      reasons: [...counts.entries()].map(([code, count]) => ({ code, label: REASON_LABELS[code] ?? code, count })).sort((a, b) => b.count - a.count),
      evaluated: evaluated.length,
      passes: { open: open.length, f: open.filter(passF).length, q: open.filter(passQ).length, coverage: open.filter(passCoverage).length, all: open.filter((o) => passF(o) && passQ(o) && passCoverage(o)).length },
      sentToday,
      queued,
    };
  }

  /**
   * Ayarlar canlı politikada yerinde güncellenir: sürüm artmaz, kuyruktaki gönderimler iptal olmaz. Ardından fırsatlar
   * yeni ayarlarla yeniden değerlendirilir. Yönetici arama sıklığını değiştirirse ilan sitesi taraması da ona eşlenir.
   */
  async save(ctx: RequestContext, input: SettingsInput): Promise<ServerShape<AutoApplyView>> {
    const policy = await this.policyOf(ctx.workspaceId);
    if (!policy) throw new AppError(422, 'POLICY_MISSING', 'Otomatik başvuru için önce profil, mail hesabı ve CV kaydedilmeli');
    const { atsThreshold, atsRewriteMode, atsCvLayout: requestedLayout, atsMaxPages: requestedPages, ...policyFields } = input;
    const previous = await this.atsSettings(ctx.workspaceId);
    const previousLayout = previous.cvLayout;
    const atsCvLayout = requestedLayout ?? previousLayout;
    const atsMaxPages = requestedPages ?? previous.maxPages;
    await this.prisma.automationPolicy.updateMany({ where: { workspaceId: ctx.workspaceId }, data: policyFields });
    const ws = await this.prisma.workspace.findUniqueOrThrow({ where: { id: ctx.workspaceId }, select: { aiSettings: true } });
    const aiSettings = { ...((ws.aiSettings ?? {}) as Record<string, unknown>), atsThreshold, atsRewriteMode, atsCvLayout, atsMaxPages };
    await this.prisma.workspace.update({ where: { id: ctx.workspaceId }, data: { aiSettings: aiSettings as Prisma.InputJsonValue } });
    // Arama sıklığı yalnızca değiştirildiyse: zamanlayıcı sıfırlanır, yöneticide ilan sitesi taraması da eşlenir.
    if (input.searchEveryHours !== policy.searchEveryHours) {
      await this.prisma.keyValue.deleteMany({ where: { key: `sched:job-search:${ctx.workspaceId}` } });
      if (ctx.isAdmin) await this.syncScraperInterval(ctx, input.searchEveryHours);
    }
    if (atsCvLayout !== previousLayout || atsMaxPages !== previous.maxPages)
      await this.outbox.emit({ workspaceId: ctx.workspaceId, eventType: 'ats.rerender', aggregateId: ctx.workspaceId, dedupKey: `ats-rerender:${ctx.workspaceId}:${Date.now()}`, payload: {} });
    await this.outbox.emit({ workspaceId: ctx.workspaceId, eventType: 'automation.reevaluate', aggregateId: policy.id, dedupKey: `auto-reevaluate:${policy.id}:${Date.now()}`, payload: {} });
    await this.audit.log({ workspaceId: ctx.workspaceId, actorId: ctx.userId, action: 'auto_apply.settings', entityType: 'AutomationPolicy', entityId: policy.id, next: input });
    return this.view(ctx);
  }

  private async syncScraperInterval(ctx: RequestContext, hours: number) {
    const config = await this.scraper.config();
    const sources = Object.fromEntries(SCRAPER_SOURCES.filter((s) => config.sources[s].enabled && config.sources[s].interval_hours !== hours).map((s) => [s, { interval_hours: hours }]));
    if (!Object.keys(sources).length) return;
    await this.scraper.updateConfig({ sources });
    await this.audit.log({ workspaceId: ctx.workspaceId, actorId: ctx.userId, action: 'scraper.config', entityType: 'ScraperConfig', entityId: 'scraper:config', next: { sources, via: 'auto_apply.settings', day: istanbulDay() } });
  }
}

@Controller('v1/home/auto-apply')
export class AutoApplyController {
  constructor(private readonly svc: AutoApplyService) {}

  @Get('settings')
  view(@Ctx() ctx: RequestContext) {
    return this.svc.view(ctx);
  }

  @Put('settings')
  save(@Ctx() ctx: RequestContext, @Body(new ZodPipe(autoApplySettingsSchema)) body: SettingsInput) {
    return this.svc.save(ctx, body);
  }
}
