import { Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../common/audit.service';
import { AppError, notFound } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { normalizeCompanyName } from '../domain/text';
import { CompanyMergeService, followMerged } from './company-merge.service';
import { DeferredListings, JobSearchService } from './job-search.service';

const DECISION_TTL_DAYS = 14;
const DECISION_LIST_LIMIT = 100;
const SAMPLE_TITLES = 5;

export type CompanyDecisionAction = 'merge' | 'separate';

export interface CompanyDecisionItem {
  id: string;
  name: string;
  domain: string | null;
  reasons: string[];
  listingCount: number;
  titles: string[];
  createdAt: Date;
  suggested: { id: string; name: string; website: string | null; openJobs: number; applications: number };
}

export interface SimilarCompany {
  id: string;
  name: string;
  level: 'certain' | 'likely';
  reasons: string[];
}

/**
 * Benzer adlı firma kararları: arka planda gelen ve kayıtlı bir firmaya benzeyen yeni firmanın ilanları kullanıcı karar
 * verene kadar bekler. "Bu firmaya ekle": yeni ad kayıtlı firmaya yönlenen gizli bir kayıt olur (aynı ad bir daha
 * sorulmaz) ve ilanlar oraya eklenir. "Farklı firma": yeni firma açılır, çift bir daha ikiz önerilmez.
 */
@Injectable()
export class CompanyDecisionService {
  private readonly logger = new Logger('CompanyDecision');

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobSearch: JobSearchService,
    private readonly companyMerge: CompanyMergeService,
    private readonly audit: AuditService,
  ) {}

  async list(workspaceId: string): Promise<CompanyDecisionItem[]> {
    const rows = await this.prisma.companyDecision.findMany({ where: { workspaceId, status: 'pending' }, orderBy: { createdAt: 'desc' }, take: DECISION_LIST_LIMIT });
    if (!rows.length) return [];
    const ids = [...new Set(rows.map((r) => r.suggestedCompanyId))];
    const [companies, jobs, attempts] = await Promise.all([
      this.prisma.company.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, website: true, mergedIntoId: true } }),
      this.prisma.job.groupBy({ by: ['companyId'], where: { companyId: { in: ids }, status: 'open' }, _count: { _all: true } }),
      this.prisma.applicationAttempt.groupBy({ by: ['companyId'], where: { companyId: { in: ids }, state: { not: 'cancelled' } }, _count: { _all: true } }),
    ]);
    const byId = new Map(companies.map((c) => [c.id, c]));
    const openJobs = new Map(jobs.map((j) => [j.companyId, j._count._all]));
    const applications = new Map(attempts.map((a) => [a.companyId, a._count._all]));
    return rows
      .filter((r) => byId.has(r.suggestedCompanyId))
      .map((r) => {
        const company = byId.get(r.suggestedCompanyId)!;
        return {
          id: r.id,
          name: r.name,
          domain: r.domain,
          reasons: r.reasons,
          listingCount: r.listingCount,
          titles: (r.payload as unknown as DeferredListings).listings.map((l) => l.title).slice(0, SAMPLE_TITLES),
          createdAt: r.createdAt,
          suggested: { id: company.id, name: company.name, website: company.website, openJobs: openJobs.get(company.id) ?? 0, applications: applications.get(company.id) ?? 0 },
        };
      });
  }

  async count(workspaceId: string) {
    return this.prisma.companyDecision.count({ where: { workspaceId, status: 'pending' } });
  }

  async decide(workspaceId: string, id: string, action: CompanyDecisionAction, actorId: string | null) {
    const decision = await this.prisma.companyDecision.findFirst({ where: { id, workspaceId } });
    if (!decision) throw notFound('Firma kararı');
    if (decision.status !== 'pending') throw new AppError(409, 'DECISION_DONE', 'Bu karar zaten verilmiş');
    const deferred = decision.payload as unknown as DeferredListings;
    const profile =
      (await this.prisma.searchProfile.findFirst({ where: { id: deferred.searchProfileId, workspaceId } })) ??
      (await this.prisma.searchProfile.findFirst({ where: { workspaceId, active: true }, orderBy: { createdAt: 'asc' } }));
    if (!profile) throw new AppError(422, 'PROFILE_MISSING', 'Arama profili bulunamadı');
    const target = await followMerged(this.prisma, await this.prisma.company.findFirst({ where: { id: decision.suggestedCompanyId, workspaceId } }));
    if (!target) throw notFound('Önerilen firma');

    if (action === 'merge') await this.redirectName(workspaceId, decision.name, target.id);
    const stats = await this.jobSearch.applyListings(profile, deferred.listings, `decision:${decision.id}`, {
      sourceKind: deferred.sourceKind ?? undefined,
      origin: deferred.origin ?? 'Firma kararı',
      announced: deferred.announced,
      trustNewCompanies: action === 'separate',
    });
    if (action === 'separate') {
      const created = await this.prisma.company.findFirst({ where: { workspaceId, normalizedName: decision.normalizedName, mergedIntoId: null } });
      if (created) await this.companyMerge.dismiss(workspaceId, created.id, target.id);
    }
    await this.prisma.companyDecision.update({ where: { id: decision.id }, data: { status: action === 'merge' ? 'merged' : 'separate', decidedAt: new Date() } });
    await this.audit.log({ workspaceId, actorId, action: `company_decision.${action}`, entityType: 'CompanyDecision', entityId: decision.id, next: { name: decision.name, target: target.name, listings: deferred.listings.length } });
    return { status: action === 'merge' ? 'merged' : 'separate', companyId: target.id, stats };
  }

  /**
   * Yeni ad, kayıtlı firmaya yönlenen gizli bir kayıt olur ve kayıtlı firmanın diğer adlarına eklenir. İlan siteleri
   * aynı adı yeniden getirdiğinde ilan doğrudan kayıtlı firmaya bağlanır.
   */
  private async redirectName(workspaceId: string, name: string, targetId: string) {
    const normalizedName = normalizeCompanyName(name);
    const existing = await this.prisma.company.findFirst({ where: { workspaceId, normalizedName } });
    if (!existing) {
      await this.prisma.company.create({ data: { workspaceId, name, normalizedName, origin: 'discovery', excluded: true, excludedReason: 'Firma kararı: başka kayıtla aynı', mergedIntoId: targetId } });
    } else if (existing.id !== targetId && !existing.mergedIntoId) {
      await this.prisma.company.update({ where: { id: existing.id }, data: { mergedIntoId: targetId, excluded: true } });
    }
    const target = await this.prisma.company.findUniqueOrThrow({ where: { id: targetId }, select: { aliases: true } });
    if (!target.aliases.some((a) => normalizeCompanyName(a) === normalizedName)) await this.prisma.company.update({ where: { id: targetId }, data: { aliases: { push: name } } });
  }

  /** Kurum ekleme öncesi: yazılan ada benzeyen kayıtlı firma. */
  async similar(workspaceId: string, name: string): Promise<SimilarCompany | null> {
    const twin = await this.companyMerge.similarTo(workspaceId, { name, domains: [], jobs: [], emailDomains: [], officePlaces: [] });
    return twin ? { id: twin.profile.id, name: twin.profile.name, level: twin.verdict.level, reasons: twin.verdict.reasons } : null;
  }

  /** Uzun süre karar verilmeyen ilanlar bayatlar; karar kalkar (ilanlar eklenmez). */
  async expire(now = new Date()) {
    const before = new Date(now.getTime() - DECISION_TTL_DAYS * 86400_000);
    const { count } = await this.prisma.companyDecision.updateMany({ where: { status: 'pending', updatedAt: { lt: before } }, data: { status: 'expired', decidedAt: now } });
    if (count) this.logger.log(`${count} firma kararı süresi dolduğu için kapandı`);
    return { expired: count };
  }
}
