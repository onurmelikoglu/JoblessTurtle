import { Injectable, Logger } from '@nestjs/common';
import { Company, Job, SearchProfile } from '@prisma/client';
import { OutboxService } from '../common/outbox.service';
import { CatalogService } from './catalog.service';
import { CompanyScoringService } from './company-scoring.service';
import { PrismaService } from '../common/prisma.service';
import { fold } from '../domain/text';
import { evaluateLocation } from '../domain/geo';
import {
  categorizeCompanyOpportunity,
  categorizeJobOpportunity,
  computeF,
  Condition,
  estimateScope,
  OpportunityCategory,
} from '../domain/scoring';
import { classifyTitle } from '../domain/titles';

/**
 * Fırsat değerlendirmesi: ilan durumu ile firmaya uygunluk bağımsızdır (doküman §4).
 * Aynı firma farklı arama profili için farklı uyum alabilir.
 */
@Injectable()
export class EvaluationService {
  private readonly logger = new Logger('Evaluation');

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly scoring: CompanyScoringService,
    private readonly catalog: CatalogService,
  ) {}

  private sectorExcluded(company: Company, profile: SearchProfile) {
    const cs = company.sectors.map(fold);
    return profile.excludedSectors.some((s) => cs.includes(fold(s)));
  }

  private sectorMatches(company: Company, profile: SearchProfile) {
    if (profile.sectors.length === 0) return true;
    const cs = [...company.sectors, ...company.services].map(fold);
    return profile.sectors.some((s) => cs.some((c) => c.includes(fold(s)) || fold(s).includes(c)));
  }

  async evaluateProfile(searchProfileId: string) {
    const profile = await this.prisma.searchProfile.findUnique({ where: { id: searchProfileId } });
    if (!profile || !profile.active) return { evaluated: 0 };
    const companies = await this.prisma.company.findMany({ where: { workspaceId: profile.workspaceId, excluded: false }, select: { id: true } });
    let n = 0;
    for (const c of companies) n += await this.evaluateCompanyForProfile(c.id, profile);
    return { evaluated: n };
  }

  async evaluateCompany(companyId: string) {
    const company = await this.prisma.company.findUnique({ where: { id: companyId } });
    if (!company) return { evaluated: 0 };
    const profiles = await this.prisma.searchProfile.findMany({ where: { workspaceId: company.workspaceId, active: true } });
    let n = 0;
    for (const p of profiles) n += await this.evaluateCompanyForProfile(companyId, p);
    // Firma her yeniden değerlendirildiğinde (yeni ilan, araştırma, ofis) paylaşılabilir bilgisi ortak kataloğa işlenir.
    await this.catalog.publish(companyId).catch((e) => this.logger.warn(`Katalog güncellenemedi (${companyId}): ${(e as Error).message}`));
    return { evaluated: n };
  }

  async evaluateCompanyForProfile(companyId: string, profile: SearchProfile): Promise<number> {
    await this.scoring.recompute(companyId);
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      include: {
        offices: true,
        jobs: { include: { listings: { include: { source: true } } } },
        sources: true,
      },
    });
    if (!company) return 0;
    const excludedSector = this.sectorExcluded(company, profile);
    const conditions = ((profile.requiredConditions ?? []) as unknown as Condition[]).map((c) => ({ ...c, met: c.met ?? null }));
    let count = 0;
    const seenKeys: string[] = [];

    for (const job of company.jobs) {
      const title = classifyTitle(job.title, profile);
      const healthy = job.listings.length === 0 || job.listings.some((l) => ['healthy', 'unknown'].includes(l.source.health));
      let category = categorizeJobOpportunity({
        titleMatch: title.match,
        jobStatus: job.status,
        sourceHealthy: healthy,
        hasConflict: !!job.conflict,
      });
      if (!category) continue;
      if (excludedSector) category = 'excluded';
      // Yurt dışı uzaktan ilanları isteyen aday için uzaktan çalışma kabul edilmiş sayılır.
      const location = evaluateLocation({ ...profile, allowRemote: profile.allowRemote || profile.abroadRemote }, job.locationText ?? job.district ?? company.offices[0]?.district, job.workMode);
      const scope = estimateScope(job.description, [...profile.keywords, ...profile.sectors], title.match);
      const fr = computeF({ titleMatch: title.match, scope, conditions, location });
      const reasons = this.jobReasons(job, title.match, location, fr.mandatoryUnknown, healthy);
      await this.upsert(profile, company, job, category, {
        titleMatch: title.match,
        f: fr.f,
        fBreakdown: fr.breakdown,
        mandatoryUnknown: fr.mandatoryUnknown,
        locationState: location,
        reasons,
      });
      seenKeys.push(job.id);
      count++;
    }

    // İlan dışı firma fırsatı (niyet / proje iş birliği yaklaşımı)
    const relevantJobs = company.jobs.filter((j) => classifyTitle(j.title, profile).match !== 'none');
    const hadCompleteCrawl = company.sources.some((s) => s.lastSuccessAt && s.health === 'healthy');
    const anyBlocked = company.sources.some((s) => ['blocked', 'degraded'].includes(s.health));
    if (relevantJobs.length === 0 && (this.sectorMatches(company, profile) || excludedSector)) {
      const category: OpportunityCategory = categorizeCompanyOpportunity({
        sectorExcluded: excludedSector,
        hadCompleteCrawl,
        anySourceBlocked: anyBlocked,
      });
      const officeText = company.offices.map((o) => [o.district, o.city, o.address].filter(Boolean).join(' ')).join(' ');
      const location = evaluateLocation(profile, officeText || null);
      const reasons: string[] = [];
      if (category === 'not_found') {
        const last = company.sources.map((s) => s.lastSuccessAt).filter(Boolean).sort().pop();
        reasons.push(`Taranan kaynaklarda hedef rol görülmedi (son kontrol ${last?.toISOString().slice(0, 16).replace('T', ' ')} UTC)`);
      }
      if (category === 'sector_target') reasons.push('Sektör uyumlu; rol ihtiyacı bilinmiyor — niyet veya proje iş birliği yaklaşımı');
      if (category === 'needs_confirmation') reasons.push('Kaynak erişimi engelli veya eksik; ilan durumu teyit gerekli');
      reasons.push(`Firma merkez/ofis konumu: ${location}`);
      await this.upsert(profile, company, null, category, {
        titleMatch: 'none',
        f: null,
        fBreakdown: {},
        mandatoryUnknown: false,
        locationState: location,
        reasons,
      });
      seenKeys.push(`company:${company.id}`);
      count++;
    }

    // Artık geçerli olmayan (ör. profil değişti) fırsatları temizle; kullanıcı işlem yaptıysa koru.
    await this.prisma.opportunity.deleteMany({
      where: { searchProfileId: profile.id, companyId, key: { notIn: seenKeys }, status: 'new' },
    });
    return count;
  }

  private jobReasons(job: Job, titleMatch: string, location: string, mandatoryUnknown: boolean, healthy: boolean) {
    const r: string[] = [];
    r.push(`Unvan eşleşmesi: ${titleMatch}`);
    r.push(`İlan durumu: ${job.status}${job.statusReason ? ` (${job.statusReason})` : ''}`);
    r.push(`Görev konumu: ${location}${job.locationText ? ` — ${job.locationText}` : ''}`);
    if (mandatoryUnknown) r.push('Zorunlu aday koşullarından en az biri doğrulanmadı');
    if (!healthy) r.push('Kaynak erişimi sorunlu');
    if (job.conflict) r.push('Kaynaklar arasında durum çelişkisi var');
    if (job.channel === 'platform') r.push('Başvuru yalnızca platformda tamamlanabilir');
    return r;
  }

  private async upsert(
    profile: SearchProfile,
    company: Company,
    job: Job | null,
    category: OpportunityCategory,
    data: { titleMatch: string; f: number | null; fBreakdown: object; mandatoryUnknown: boolean; locationState: string; reasons: string[] },
  ) {
    const key = job?.id ?? `company:${company.id}`;
    const existing = await this.prisma.opportunity.findUnique({ where: { searchProfileId_key: { searchProfileId: profile.id, key } } });
    const payload = {
      category,
      titleMatch: data.titleMatch,
      q: company.qScore,
      coverage: company.qCoverage,
      f: data.f,
      fBreakdown: data.fBreakdown as any,
      mandatoryUnknown: data.mandatoryUnknown,
      locationState: data.locationState,
      reasons: data.reasons,
      computedAt: new Date(),
    };
    if (!existing) {
      const opp = await this.prisma.opportunity.create({
        data: { ...payload, workspaceId: profile.workspaceId, searchProfileId: profile.id, companyId: company.id, jobId: job?.id ?? null, key },
      });
      if (category === 'target_open' || category === 'adjacent_open') {
        await this.outbox.emit({
          workspaceId: profile.workspaceId,
          eventType: 'opportunity.new',
          aggregateId: opp.id,
          dedupKey: `opp-new:${opp.id}`,
          payload: { opportunityId: opp.id },
        });
      }
      return opp;
    }
    const becameOpen = existing.category !== category && (category === 'target_open' || category === 'adjacent_open');
    // Kullanıcının yok saydığı fırsat otomatik olarak geri açılmaz ve otomasyonu tetiklemez.
    const opp = await this.prisma.opportunity.update({ where: { id: existing.id }, data: payload });
    if (existing.status === 'dismissed') return opp;
    if (becameOpen || (existing.f ?? -1) !== (data.f ?? -1)) {
      await this.outbox.emit({
        workspaceId: profile.workspaceId,
        eventType: becameOpen ? 'opportunity.new' : 'opportunity.updated',
        aggregateId: opp.id,
        dedupKey: `opp-${becameOpen ? 'new' : 'upd'}:${opp.id}:${opp.computedAt.getTime()}`,
        payload: { opportunityId: opp.id },
      });
    }
    return opp;
  }
}
