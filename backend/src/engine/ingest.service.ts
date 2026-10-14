import { Injectable, Logger } from '@nestjs/common';
import { Company, JobListing, Prisma, SourceConnector } from '@prisma/client';
import { hashObject } from '../common/crypto';
import { OutboxService } from '../common/outbox.service';
import { PrismaService } from '../common/prisma.service';
import { classifyPublishedEmail, cleanEmail, domainMatches, isValidEmail } from '../domain/contacts';
import { detectLocation } from '../domain/geo';
import { JobSearchProfile, listingRejection } from '../domain/job-search';
import { mergeJobStatus, nextListingState, ListingStatus, MISSING_THRESHOLD, reportedStatus } from '../domain/listing-status';
import { normalizeCompanyName, normalizeDomain } from '../domain/text';
import { normalizeTitle } from '../domain/titles';
import { AddressBookService } from './address-book.service';
import { connectorFor } from './connectors/registry';
import { CollectResult, RawListing } from './connectors/types';

export const CRAWL_STUCK_MS = 30 * 60_000;
const TITLE_NORMALIZATION_KEY = 'jobs:normalized-title:v2';
const MAX_SAVED_CONTACTS = 30;

function listingHash(l: RawListing) {
  return hashObject({ t: l.title, l: l.locationText ?? null, d: l.description ?? null, v: l.validThrough?.toISOString() ?? null, c: !!l.closedMarker });
}

function diffFields(prev: Partial<JobListing> | null, next: RawListing) {
  if (!prev) return null;
  const d: Record<string, { from: unknown; to: unknown }> = {};
  if (prev.title !== next.title) d.title = { from: prev.title, to: next.title };
  if ((prev.locationText ?? null) !== (next.locationText ?? null)) d.locationText = { from: prev.locationText, to: next.locationText };
  const pv = prev.validThrough ? prev.validThrough.toISOString() : null;
  const nv = next.validThrough ? next.validThrough.toISOString() : null;
  if (pv !== nv) d.validThrough = { from: pv, to: nv };
  return Object.keys(d).length ? d : null;
}

@Injectable()
export class IngestService {
  private readonly logger = new Logger('Ingest');

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly addressBook: AddressBookService,
  ) {}

  /** İlandaki başvuru adresi geçersiz olduğu bilinen bir adresse ilan e-postayla başvurulabilir sayılmaz. */
  private async liveEmail(email: string | null | undefined) {
    return email && !(await this.addressBook.isDead(email)) ? email : null;
  }

  /**
   * Unvan sadeleştirme kuralları değiştiğinde saklanan değerler bir kez yeniden hesaplanır; yoksa bilinen bir ilanın
   * başka kaynaktan gelen kopyası aynı ilanla eşleşmez.
   */
  async renormalizeTitles() {
    if (await this.prisma.keyValue.findUnique({ where: { key: TITLE_NORMALIZATION_KEY } })) return { skipped: true };
    const jobs = await this.prisma.job.findMany({ select: { id: true, title: true, normalizedTitle: true } });
    const stale = jobs.filter((j) => normalizeTitle(j.title) !== j.normalizedTitle);
    for (const job of stale) await this.prisma.job.update({ where: { id: job.id }, data: { normalizedTitle: normalizeTitle(job.title) } });
    await this.prisma.keyValue.create({ data: { key: TITLE_NORMALIZATION_KEY, value: { at: new Date().toISOString(), updated: stale.length } } });
    return { updated: stale.length };
  }

  async closeStuckRuns(now = new Date()) {
    const r = await this.prisma.crawlRun.updateMany({
      where: { state: 'running', startedAt: { lt: new Date(now.getTime() - CRAWL_STUCK_MS) } },
      data: { state: 'failed', error: 'interrupted', finishedAt: now },
    });
    if (r.count) this.logger.warn(`${r.count} yarım kalmış tarama kaydı kapatıldı`);
    return r.count;
  }

  /** Bir kaynağı çalıştırır: gözlem kaydı, listing/ilan güncelleme, kaynak sağlığı ve olaylar. */
  async runSource(sourceId: string, trigger: 'schedule' | 'manual' | 'verify' = 'schedule') {
    const source = await this.prisma.sourceConnector.findUnique({ where: { id: sourceId } });
    if (!source || !source.enabled) return null;
    const connector = connectorFor(source.kind);
    if (connector.accessMode === 'manual') return null;
    const run = await this.prisma.crawlRun.create({ data: { workspaceId: source.workspaceId, sourceId, trigger } });
    let result: CollectResult;
    try {
      result = await connector.collect(source);
    } catch (e) {
      result = { state: 'error', complete: false, listings: [], pages: 0, sourceUrl: '', error: (e as Error).message };
    }
    const observation = await this.prisma.sourceObservation.create({
      data: {
        workspaceId: source.workspaceId,
        sourceId,
        crawlRunId: run.id,
        sourceUrl: result.sourceUrl,
        responseState: result.state,
        httpStatus: result.httpStatus ?? null,
        extractorVersion: connector.extractorVersion,
        contentHash: result.contentHash ?? null,
        coverage: result.complete ? 'full' : 'partial',
        // İzinli alanlar: kısa özet, ham platform metni saklanmaz.
        permittedSnapshot: { count: result.listings.length, ids: result.listings.slice(0, 200).map((l) => l.externalId) },
      },
    });

    let stats = { seen: 0, created: 0, closed: 0 };
    const affectedCompanies = new Set<string>();
    if (result.state === 'ok') {
      if (connector.aggregator) result.listings = await this.relevantListings(source.workspaceId, result.listings);
      stats = await this.applyListings(source, result, observation.id, affectedCompanies);
      if (result.contacts?.length && source.companyId) await this.saveContacts(source, result.contacts);
    } else if (result.state === 'not_modified') {
      await this.prisma.jobListing.updateMany({ where: { sourceId, status: 'open' }, data: { lastVerifiedAt: new Date(), lastSeenAt: new Date() } });
      const jobs = await this.prisma.jobListing.findMany({ where: { sourceId }, select: { job: { select: { companyId: true, id: true } } } });
      jobs.forEach((j) => affectedCompanies.add(j.job.companyId));
      for (const j of jobs) await this.refreshJob(j.job.id);
    } else {
      const listings = await this.prisma.jobListing.findMany({ where: { sourceId }, select: { job: { select: { companyId: true } } } });
      listings.forEach((l) => affectedCompanies.add(l.job.companyId));
    }

    await this.updateSourceHealth(source, result);
    if (source.kind === 'demo') {
      const cfg = (source.config ?? {}) as Record<string, unknown>;
      await this.prisma.sourceConnector.update({ where: { id: sourceId }, data: { config: { ...cfg, run: ((cfg.run as number) ?? 1) + 1 } as Prisma.InputJsonValue } });
    }
    const runState = result.state === 'ok' || result.state === 'not_modified' ? (result.complete ? 'succeeded' : 'partial') : ['forbidden', 'blocked'].includes(result.state) ? 'blocked' : 'failed';
    await this.prisma.crawlRun.update({
      where: { id: run.id },
      data: {
        state: runState,
        complete: result.complete,
        pages: result.pages,
        listingsSeen: stats.seen,
        listingsNew: stats.created,
        listingsClosed: stats.closed,
        error: result.error ?? null,
        finishedAt: new Date(),
        metrics: { httpStatus: result.httpStatus ?? null, state: result.state },
      },
    });
    if (source.companyId) affectedCompanies.add(source.companyId);
    for (const companyId of affectedCompanies) {
      await this.outbox.emit({
        workspaceId: source.workspaceId,
        eventType: 'evaluate.company',
        aggregateId: companyId,
        dedupKey: `eval-company:${companyId}:${run.id}`,
        payload: { companyId },
      });
    }
    return { runId: run.id, state: runState, ...stats };
  }

  private async resolveCompany(source: SourceConnector, raw: RawListing): Promise<Company> {
    if (source.companyId) return this.prisma.company.findUniqueOrThrow({ where: { id: source.companyId } });
    const domain = normalizeDomain(raw.companyDomain ?? null);
    if (domain) {
      const byDomain = await this.prisma.company.findFirst({ where: { workspaceId: source.workspaceId, canonicalDomain: domain } });
      if (byDomain) return byDomain;
    }
    const name = raw.companyName?.trim() || 'Bilinmeyen firma';
    const normalizedName = normalizeCompanyName(name);
    const byName = await this.prisma.company.findFirst({ where: { workspaceId: source.workspaceId, normalizedName } });
    if (byName) return byName;
    return this.prisma.company.create({
      data: { workspaceId: source.workspaceId, name, normalizedName, canonicalDomain: domain, origin: 'discovery' },
    });
  }

  /**
   * Kanonik ilan eşlemesi: önce resmî requisition_id, sonra aynı firma + normalize unvan + ofis.
   * Farklı kaynaktan gelen yakın eşleşme mergeReview ile işaretlenir.
   */
  private async resolveJob(source: SourceConnector, company: Company, raw: RawListing) {
    const normalizedTitle = normalizeTitle(raw.title);
    const loc = detectLocation(raw.locationText);
    if (raw.requisitionId) {
      const key = `req:${company.id}:${raw.requisitionId}`;
      const byReq = await this.prisma.job.findUnique({ where: { workspaceId_canonicalKey: { workspaceId: source.workspaceId, canonicalKey: key } } });
      if (byReq) return { job: byReq, created: false };
    }
    const candidates = await this.prisma.job.findMany({
      where: { workspaceId: source.workspaceId, companyId: company.id, normalizedTitle, status: { in: ['open', 'unknown', 'stale'] } },
      include: { listings: { select: { sourceId: true } } },
    });
    const match = candidates.find((j) => (j.district ?? null) === (loc.district ?? null) || !j.district || !loc.district);
    if (match) {
      const otherSource = match.listings.some((l) => l.sourceId !== source.id);
      if (otherSource && !raw.requisitionId && !match.mergeReview) {
        await this.prisma.job.update({ where: { id: match.id }, data: { mergeReview: true } });
      }
      return { job: match, created: false };
    }
    const connector = connectorFor(source.kind);
    const applyEmail = await this.liveEmail(raw.applyEmail);
    const job = await this.prisma.job.create({
      data: {
        workspaceId: source.workspaceId,
        companyId: company.id,
        canonicalKey: raw.requisitionId ? `req:${company.id}:${raw.requisitionId}` : `src:${source.id}:${raw.externalId}`,
        requisitionId: raw.requisitionId ?? null,
        title: raw.title,
        normalizedTitle,
        locationText: raw.locationText ?? null,
        district: loc.district,
        city: loc.city,
        workMode: raw.workMode ?? (loc.remote ? 'remote' : loc.hybrid ? 'hybrid' : 'unknown'),
        status: 'open',
        description: raw.description ?? null,
        applyEmail,
        applyUrl: raw.applyUrl ?? raw.url ?? null,
        channel: applyEmail ? 'email' : connector.applyChannel === 'email' ? 'unknown' : connector.applyChannel === 'platform' ? 'platform' : 'ats_form',
      },
    });
    return { job, created: true };
  }

  /** Manuel/uyarı kaydı: kullanıcının girdiği ilan tek gözlem olarak işlenir (eksik tarama; kapanış üretmez). */
  async recordManual(source: SourceConnector, raw: RawListing) {
    await this.recordFound(source, [raw]);
    return this.prisma.jobListing.findUniqueOrThrow({ where: { sourceId_externalId: { sourceId: source.id, externalId: raw.externalId } }, include: { job: true } });
  }

  /** Dışarıdan bildirilen ilanlar (elle giriş, web araması): tek gözlem olarak işlenir; yokluk kapanış sayılmaz. */
  async recordFound(source: SourceConnector, listings: RawListing[]) {
    const affected = new Set<string>();
    const sourceUrl = listings[0]?.url ?? `manual://${source.kind}`;
    const obs = await this.prisma.sourceObservation.create({
      data: { workspaceId: source.workspaceId, sourceId: source.id, sourceUrl, responseState: 'ok', extractorVersion: 'manual@1', coverage: 'partial' },
    });
    const stats = await this.applyListings(source, { state: 'ok', complete: false, listings, pages: 0, sourceUrl }, obs.id, affected);
    for (const companyId of affected) {
      await this.outbox.emit({ workspaceId: source.workspaceId, eventType: 'evaluate.company', aggregateId: companyId, dedupKey: `eval-company:${companyId}:manual:${obs.id}`, payload: { companyId } });
    }
    return { ...stats, companyIds: [...affected] };
  }

  /** Çalışma alanının toplayıcı kaynağı (firmaya bağlı olmayan); yoksa oluşturulur. */
  async aggregatorSource(workspaceId: string, kind: string, config: Record<string, unknown> = {}) {
    const connector = connectorFor(kind);
    const existing = await this.prisma.sourceConnector.findFirst({ where: { workspaceId, kind, companyId: null } });
    if (existing) return existing;
    return this.prisma.sourceConnector.create({
      data: {
        workspaceId,
        kind,
        name: connector.label,
        config: config as Prisma.InputJsonValue,
        accessMode: connector.accessMode,
        capabilities: connector.capabilities,
        isOfficial: false,
        health: 'healthy',
        minIntervalMinutes: connector.minIntervalMinutes,
        intervalMinutes: connector.defaultIntervalMinutes,
        ...(connector.accessMode === 'manual' ? {} : { nextRunAt: new Date() }),
      },
    });
  }

  /** Toplayıcı kaynaktan gelenlerden yalnızca çalışma alanındaki bir arama profiline uyan ilanlar kalır. */
  private async relevantListings(workspaceId: string, listings: RawListing[]) {
    const profiles: JobSearchProfile[] = await this.prisma.searchProfile.findMany({ where: { workspaceId, active: true } });
    return listings.filter((l) => profiles.some((p) => !listingRejection(p, l)));
  }

  private async applyListings(source: SourceConnector, result: CollectResult, observationId: string, affected: Set<string>) {
    const now = new Date();
    const connector = connectorFor(source.kind);
    // Toplayıcı kaynak resmî doğrulama sayılmaz: ilan görünür ama otomatik başvurunun tazelik koşulunu karşılamaz.
    const verifiedAt = connector.aggregator ? null : now;
    let created = 0;
    let closed = 0;
    const seen = new Set<string>();
    const touchedJobs = new Set<string>();

    for (const raw of result.listings) {
      if (!raw.externalId || !raw.title) continue;
      seen.add(raw.externalId);
      const hash = listingHash(raw);
      const existing = await this.prisma.jobListing.findUnique({ where: { sourceId_externalId: { sourceId: source.id, externalId: raw.externalId } } });
      if (!existing) {
        const company = await this.resolveCompany(source, raw);
        const { job, created: jobCreated } = await this.resolveJob(source, company, raw);
        const t = nextListingState({ status: 'open', missingCount: 0, openCycle: 1 }, { kind: 'present', closedMarker: raw.closedMarker, validThrough: raw.validThrough, now });
        const status = raw.unverified ? reportedStatus(t.status) : t.status;
        const listing = await this.prisma.jobListing.create({
          data: {
            workspaceId: source.workspaceId,
            jobId: job.id,
            sourceId: source.id,
            externalId: raw.externalId,
            canonicalUrl: raw.url ?? null,
            isOfficial: connector.isOfficial && source.isOfficial,
            status,
            statusReason: raw.unverified && status === 'unknown' ? 'reported_unverified' : t.status === 'open' ? 'first_seen' : t.statusReason,
            title: raw.title,
            locationText: raw.locationText ?? null,
            applyUrl: raw.applyUrl ?? null,
            applyEmail: raw.applyEmail ?? null,
            postedAt: raw.postedAt ?? null,
            sourceUpdatedAt: raw.updatedAt ?? null,
            validThrough: raw.validThrough ?? null,
            lastVerifiedAt: verifiedAt,
            contentHash: hash,
          },
        });
        await this.prisma.jobSnapshot.create({
          data: { listingId: listing.id, observationId, title: raw.title, normalizedFields: { locationText: raw.locationText ?? null }, status: listing.status, statusReason: listing.statusReason, contentHash: hash },
        });
        created++;
        touchedJobs.add(job.id);
        affected.add(company.id);
        if (jobCreated) {
          await this.outbox.emit({ workspaceId: source.workspaceId, eventType: 'job.new', aggregateId: job.id, dedupKey: `job-new:${job.id}`, payload: { jobId: job.id } });
        }
        continue;
      }
      const t = nextListingState(
        { status: existing.status as ListingStatus, missingCount: existing.missingCount, openCycle: existing.openCycle, statusReason: existing.statusReason },
        { kind: 'present', closedMarker: raw.closedMarker, validThrough: raw.validThrough, now },
      );
      const diff = diffFields(existing, raw);
      if (raw.unverified) {
        const status = reportedStatus(t.status, existing.status as ListingStatus);
        if (status !== t.status) Object.assign(t, { status, statusReason: existing.statusReason, openCycle: existing.openCycle, reopened: false, closedNow: false, changed: false });
      }
      await this.prisma.jobListing.update({
        where: { id: existing.id },
        data: {
          status: t.status,
          statusReason: t.statusReason ?? null,
          missingCount: t.missingCount,
          openCycle: t.openCycle,
          title: raw.title,
          locationText: raw.locationText ?? existing.locationText,
          applyUrl: raw.applyUrl ?? existing.applyUrl,
          applyEmail: raw.applyEmail ?? existing.applyEmail,
          sourceUpdatedAt: raw.updatedAt ?? existing.sourceUpdatedAt,
          validThrough: raw.validThrough ?? existing.validThrough,
          lastSeenAt: now,
          lastVerifiedAt: verifiedAt ?? existing.lastVerifiedAt,
          contentHash: hash,
        },
      });
      if (hash !== existing.contentHash || t.changed) {
        await this.prisma.jobSnapshot.create({
          data: {
            listingId: existing.id,
            observationId,
            title: raw.title,
            normalizedFields: { locationText: raw.locationText ?? null },
            diff: (diff ?? undefined) as Prisma.InputJsonValue | undefined,
            status: t.status,
            statusReason: t.statusReason ?? null,
            openCycle: t.openCycle,
            contentHash: hash,
          },
        });
        if (diff) {
          await this.outbox.emit({ workspaceId: source.workspaceId, eventType: 'job.changed', aggregateId: existing.jobId, dedupKey: `job-changed:${existing.jobId}:${hash}`, payload: { jobId: existing.jobId, diff } });
        }
      }
      if (t.closedNow) closed++;
      if (t.reopened) {
        await this.outbox.emit({ workspaceId: source.workspaceId, eventType: 'job.reopened', aggregateId: existing.jobId, dedupKey: `job-reopen:${existing.jobId}:${t.openCycle}`, payload: { jobId: existing.jobId } });
      }
      touchedJobs.add(existing.jobId);
    }

    // Listede görülmeyen ilanlar: yalnızca eksiksiz başarılı taramada yokluk sayılır; eşikte detay kontrolü yapılır.
    if (result.complete) {
      const missing = await this.prisma.jobListing.findMany({
        where: { sourceId: source.id, status: { in: ['open', 'unknown', 'stale'] }, externalId: { notIn: [...seen] } },
      });
      for (const l of missing) {
        let detail: 'not_found' | 'closed' | 'open' | 'unavailable' | undefined;
        if (l.missingCount + 1 >= MISSING_THRESHOLD) {
          try {
            detail = await connector.verify(source, l.externalId, l.canonicalUrl);
          } catch {
            detail = 'unavailable';
          }
        }
        const t = nextListingState(
          { status: l.status as ListingStatus, missingCount: l.missingCount, openCycle: l.openCycle },
          { kind: 'absent', crawlComplete: true, detail },
        );
        await this.prisma.jobListing.update({
          where: { id: l.id },
          data: { status: t.status, statusReason: t.statusReason ?? null, missingCount: t.missingCount, ...(detail === 'open' ? { lastVerifiedAt: now } : {}) },
        });
        if (t.changed) {
          await this.prisma.jobSnapshot.create({
            data: { listingId: l.id, observationId, title: l.title, status: t.status, statusReason: t.statusReason ?? null, openCycle: t.openCycle },
          });
        }
        if (t.closedNow) closed++;
        touchedJobs.add(l.jobId);
      }
    }

    for (const jobId of touchedJobs) {
      const job = await this.refreshJob(jobId);
      if (job) affected.add(job.companyId);
    }
    return { seen: seen.size, created, closed };
  }

  /** Kanonik iş durumunu listelerden yeniden hesaplar; kapanışta bekleyen ilan başvurularını durdurur. */
  async refreshJob(jobId: string) {
    const job = await this.prisma.job.findUnique({ where: { id: jobId }, include: { listings: { include: { source: true } } } });
    if (!job) return null;
    const merged = mergeJobStatus(
      job.listings.map((l) => ({
        isOfficial: l.isOfficial,
        status: l.status as ListingStatus,
        lastVerifiedAt: l.lastVerifiedAt,
        sourceHealthy: ['healthy', 'unknown'].includes(l.source.health),
      })),
    );
    const best = job.listings.filter((l) => l.status === 'open').sort((a, b) => Number(b.isOfficial) - Number(a.isOfficial))[0] ?? job.listings[0];
    const lastVerifiedAt = job.listings.map((l) => l.lastVerifiedAt).filter(Boolean).sort((a, b) => b!.getTime() - a!.getTime())[0] ?? null;
    const reopened = job.status === 'closed' && merged.status === 'open';
    const closedNow = job.status !== 'closed' && merged.status === 'closed';
    const loc = detectLocation(best?.locationText ?? job.locationText);
    const updated = await this.prisma.job.update({
      where: { id: jobId },
      data: {
        status: merged.status,
        statusReason: best?.statusReason ?? null,
        conflict: merged.conflict ? { message: merged.conflict, at: new Date().toISOString() } : Prisma.DbNull,
        openCycle: reopened ? job.openCycle + 1 : job.openCycle,
        closedAt: closedNow ? new Date() : merged.status === 'open' ? null : job.closedAt,
        lastSeenAt: best?.lastSeenAt ?? job.lastSeenAt,
        lastVerifiedAt,
        title: best?.title ?? job.title,
        locationText: best?.locationText ?? job.locationText,
        district: loc.district ?? job.district,
        city: loc.city ?? job.city,
        applyEmail: job.applyEmail ?? (await this.liveEmail(best?.applyEmail)),
      },
    });
    if (closedNow) {
      await this.outbox.emit({ workspaceId: job.workspaceId, eventType: 'job.closed', aggregateId: jobId, dedupKey: `job-closed:${jobId}:${job.openCycle}`, payload: { jobId } });
    }
    return updated;
  }

  private async updateSourceHealth(source: SourceConnector, result: CollectResult) {
    const now = new Date();
    const interval = Math.max(source.intervalMinutes, source.minIntervalMinutes);
    let data: Prisma.SourceConnectorUpdateInput = { lastRunAt: now };
    const failures = source.consecutiveFailures + 1;
    const backoffMinutes = Math.min(interval * 2 ** Math.min(failures, 6), 24 * 60) + Math.random() * 2;
    switch (result.state) {
      case 'ok':
      case 'not_modified':
        data = {
          ...data,
          health: result.complete || source.kind === 'career_page' || connectorFor(source.kind).aggregator ? 'healthy' : 'degraded',
          healthReason: result.complete ? null : 'Tarama kapsamı eksik — yokluk kapanış sayılmaz',
          consecutiveFailures: 0,
          lastSuccessAt: now,
          etag: result.etag ?? source.etag,
          lastModified: result.lastModified ?? source.lastModified,
          lastContentHash: result.contentHash ?? source.lastContentHash,
          nextRunAt: new Date(now.getTime() + interval * 60_000),
          backoffUntil: null,
        };
        break;
      case 'rate_limited': {
        const wait = result.retryAfterSeconds ? result.retryAfterSeconds * 1000 : backoffMinutes * 60_000;
        data = { ...data, health: 'degraded', healthReason: 'Kota aşıldı (429) — Retry-After uygulanıyor', consecutiveFailures: failures, backoffUntil: new Date(now.getTime() + wait), nextRunAt: new Date(now.getTime() + wait) };
        break;
      }
      case 'forbidden':
      case 'blocked':
        // Erişim engeli: adaptör duraklatılır, alternatif izinli kanal veya manuel işlem önerilir.
        data = {
          ...data,
          health: 'blocked',
          healthReason: result.error ?? 'Erişim engellendi (403/giriş/CAPTCHA). Kaynak duraklatıldı; izinli kanal veya manuel kayıt kullanın.',
          consecutiveFailures: failures,
          nextRunAt: new Date(now.getTime() + 24 * 3600_000),
        };
        break;
      case 'unauthorized':
        data = { ...data, health: 'degraded', healthReason: 'Yetki yenileme gerekli (401)', consecutiveFailures: failures, nextRunAt: new Date(now.getTime() + backoffMinutes * 60_000) };
        break;
      case 'not_found':
        data = { ...data, health: 'degraded', healthReason: 'Kaynak adresi bulunamadı (404) — yapılandırmayı kontrol edin', consecutiveFailures: failures, nextRunAt: new Date(now.getTime() + backoffMinutes * 60_000) };
        break;
      default:
        data = { ...data, health: 'degraded', healthReason: result.error ?? `Geçici hata (${result.state})`, consecutiveFailures: failures, nextRunAt: new Date(now.getTime() + backoffMinutes * 60_000) };
    }
    await this.prisma.sourceConnector.update({ where: { id: source.id }, data });
    const wasHealthy = source.health === 'healthy' || source.health === 'unknown';
    if (wasHealthy && ['forbidden', 'blocked'].includes(result.state)) {
      await this.outbox.emit({
        workspaceId: source.workspaceId,
        eventType: 'notify',
        aggregateId: source.id,
        dedupKey: `source-blocked:${source.id}:${now.toISOString().slice(0, 13)}`,
        payload: { type: 'source_blocked', title: `Kaynak durdu: ${source.name}`, body: 'Erişim engeli nedeniyle kaynak duraklatıldı; otomatik ilan başvurusu bu kaynakta durdu.', link: '/sources' },
      });
    }
  }

  /**
   * Resmî sayfada yayımlanmış adresleri iletişim noktası olarak kaydeder (tahmin/örüntü üretimi yok). Geçersiz olduğu
   * bilinen adres yeniden kaydedilmez; başka bir çalışma alanında ulaştığı görülen adres doğrulanmış sayılır.
   */
  async saveContacts(source: SourceConnector, contacts: { email: string; sourceUrl: string | null; kind?: string }[], foundBy = 'crawl') {
    if (!source.companyId) return;
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: source.companyId } });
    const dead = await this.addressBook.deadAmong(contacts.map((c) => cleanEmail(c.email)));
    const saved: { email: string; sourceUrl: string | null }[] = [];
    for (const raw of contacts.slice(0, MAX_SAVED_CONTACTS)) {
      const c = { ...raw, email: cleanEmail(raw.email) };
      if (!isValidEmail(c.email) || dead.has(c.email)) continue;
      saved.push(c);
      const official = domainMatches(c.email, company.canonicalDomain, company.aliases);
      const classified = classifyPublishedEmail(c.email);
      const cls = raw.kind ? { kind: raw.kind as typeof classified.kind, note: raw.kind === classified.kind ? classified.note : undefined } : classified;
      await this.prisma.contactPoint.upsert({
        where: { companyId_email: { companyId: company.id, email: c.email } },
        create: {
          workspaceId: company.workspaceId,
          companyId: company.id,
          email: c.email,
          kind: cls.kind,
          purpose: cls.note ?? (cls.kind === 'candidate_hr' ? 'Eski sosyal medya paylaşımından; aktifliği doğrulanmadı' : cls.kind === 'official_hr' ? 'Kariyer/İK başvuru adresi' : 'Genel iletişim'),
          sourceUrl: c.sourceUrl,
          confidence: official ? (cls.kind === 'official_hr' ? 'high' : 'medium') : 'low',
          ownershipEvidence: official ? 'Resmî sitede yayımlanmış; alan adı eşleşiyor' : 'Alan adı firma domaini ile eşleşmiyor',
          // Resmî sitede yayımlanmış ve alan adı eşleşen İK adresi kaynakla doğrulanmış sayılır.
          verifiedAt: official && cls.kind === 'official_hr' ? new Date() : null,
          verifiedBy: official && cls.kind === 'official_hr' ? 'source' : null,
        },
        update: { ...(c.sourceUrl ? { sourceUrl: c.sourceUrl } : {}), discoveredAt: new Date() },
      });
      // Doğrulaması düşmüş resmî İK adresi kaynağında yeniden görüldüyse yeniden doğrulanmış sayılır.
      if (official && cls.kind === 'official_hr') {
        await this.prisma.contactPoint.updateMany({ where: { companyId: company.id, email: c.email, kind: 'official_hr', verifiedAt: null, suppressed: false }, data: { verifiedAt: new Date(), verifiedBy: 'source' } });
      }
    }
    await this.addressBook.noteFound(saved.map((c) => ({ ...c, foundBy })), company);
    await this.addressBook.syncContacts(company.id);
  }
}
