import { Injectable, Logger } from '@nestjs/common';
import { Prisma, SearchProfile } from '@prisma/client';
import { errorMessage } from '../common/errors';
import { OutboxService } from '../common/outbox.service';
import { PrismaService } from '../common/prisma.service';
import { isValidEmail } from '../domain/contacts';
import {
  buildJobQueries,
  companyNameKey,
  JobQuery,
  JobQueryLog,
  listingExternalId,
  listingRejection,
  normalizeListingUrl,
  noteJobQuery,
  pickJobQueries,
  PLATFORM_SETS,
  searchLocationOf,
  WEB_SEARCH_SOURCE,
} from '../domain/job-search';
import { normalizeCompanyName, normalizeDomain, stripHtml } from '../domain/text';
import { classifyTitle } from '../domain/titles';
import { AiService } from './ai/ai.service';
import { AppliedCompaniesService } from './applied-companies.service';
import { detectAtsSource } from './connectors/ats-detect';
import { RELOCATION_BOARDS, REMOTE_BOARDS } from './connectors/boards';
import { CLOSED_TEXT, parseJobPostingJsonLd } from './connectors/career-page';
import { fetchSource, robotsAllows } from './connectors/http';
import { CONNECTORS } from './connectors/registry';
import { Connector, RawListing } from './connectors/types';
import { IngestService } from './ingest.service';
import { LearningService } from './learning.service';
import { ResearchService } from './research.service';

const LOG_KEY = (searchProfileId: string) => `jobsearch:log:${searchProfileId}`;
const DAY_MS = 86_400_000;
const LISTINGS_PER_QUERY = 25;
const KNOWN_IN_PROMPT = 60;
const KNOWN_SCAN = 400;
const PAGE_CHECKS_PER_QUERY = 12;
const BOARD_TERMS = 4;
const RECHECK_AFTER_DAYS = 10;
const EXPIRE_AFTER_DAYS = 30;
const RECHECKS_PER_RUN = 40;
const NOTIFIED_TITLES = 3;
/** Bildirim bağlantısındaki ilan sayısı sınırı; adres kısa kalsın diye. */
const MAX_LINKED_JOBS = 60;
/** Firma alan adı yerine yazılmış ilan sitesi ve başvuru panosu adresleri firma kimliği sayılmaz. */
const PLATFORM_DOMAIN = /(^|\.)(linkedin\.com|indeed\.com|kariyer\.net|glassdoor\.com|glassdoor\.com\.tr|youthall\.com|secretcv\.com|eleman\.net|yenibiris\.com|toptalent\.co|wellfound\.com|greenhouse\.io|lever\.co|workable\.com|teamtailor\.com|smartrecruiters\.com|recruitee\.com|ashbyhq\.com|personio\.(de|com)|remotive\.com|remoteok\.com|himalayas\.app|arbeitnow\.com)$/;

export interface ApplyOptions {
  /** İlanların kaydedileceği toplayıcı kaynak türü (varsayılan: web araması). */
  sourceKind?: string;
  /** İlanı sitenin kendisi az önce duyurdu (iş alarmı): sayfası yoklanmaz, açık kabul edilir. */
  announced?: boolean;
  /** Bildirim başlığında ilanların nereden geldiği ("Kariyer.net taraması"). */
  origin?: string;
}

export interface FoundListing {
  title: string;
  company: string;
  companyDomain?: string | null;
  careersUrl?: string | null;
  location?: string | null;
  workMode?: 'onsite' | 'hybrid' | 'remote' | 'unknown';
  url: string;
  platform?: string | null;
  postedAt?: string | null;
  applyEmail?: string | null;
}
type Candidate = FoundListing & { externalId: string };
type PageCheck = { state: 'open' | 'closed' | 'unverified'; posting?: RawListing };
type CompanyRef = { id: string; name: string; canonicalDomain: string | null };

export interface JobSearchStats {
  returned: number;
  accepted: number;
  fresh: number;
  known: number;
  closed: number;
  newCompanies: number;
  rejected: Record<string, number>;
}

function dateOf(value: string | null | undefined) {
  const at = value ? new Date(value) : null;
  return at && !Number.isNaN(at.getTime()) && at.getTime() <= Date.now() + DAY_MS ? at : null;
}

/** Aynı ilan iki kez geldiyse ilk kayıt esas alınır; onda boş kalan alanlar ikincisinden tamamlanır. */
function mergeDuplicate(first: Candidate | undefined, next: Candidate): Candidate {
  if (!first) return next;
  const filled = Object.fromEntries(Object.entries(first).filter(([, value]) => value !== null && value !== undefined && value !== ''));
  return { ...next, ...filled } as Candidate;
}

function companyDomainOf(l: FoundListing) {
  const domain = normalizeDomain(l.companyDomain ?? null);
  return domain && !PLATFORM_DOMAIN.test(domain) ? domain : null;
}

/**
 * İlan arama motoru: firma kariyer sayfalarını beklemeden, aranan unvanlar için açık ilanları web aramasıyla
 * (LinkedIn, Kariyer.net, Indeed ve benzerleri dahil) ve herkese açık ilan panolarından bulur. Platformlara oturum
 * açan ya da arama sayfalarını kazıyan bot yoktur; bulunan ilan sayfası robots.txt izin veriyorsa okunup doğrulanır.
 */
@Injectable()
export class JobSearchService {
  private readonly logger = new Logger('JobSearch');

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
    private readonly ingest: IngestService,
    private readonly research: ResearchService,
    private readonly outbox: OutboxService,
    private readonly learning: LearningService,
    private readonly appliedCompanies: AppliedCompaniesService,
  ) {}

  async queryLog(searchProfileId: string): Promise<JobQueryLog> {
    const kv = await this.prisma.keyValue.findUnique({ where: { key: LOG_KEY(searchProfileId) } });
    return (kv?.value ?? {}) as unknown as JobQueryLog;
  }

  private async saveLog(searchProfileId: string, log: JobQueryLog) {
    const value = log as unknown as Prisma.InputJsonValue;
    await this.prisma.keyValue.upsert({ where: { key: LOG_KEY(searchProfileId) }, create: { key: LOG_KEY(searchProfileId), value }, update: { value } });
  }

  private activeProfiles(workspaceId: string, searchProfileId?: string) {
    return this.prisma.searchProfile.findMany({ where: { workspaceId, active: true, ...(searchProfileId ? { id: searchProfileId } : {}) }, orderBy: { createdAt: 'asc' } });
  }

  /**
   * Sıradaki sorguları kuyruğa alır; her sorgu ayrı bir iş olur. Verimsiz sorgular kendiliğinden seyrekleşir
   * (domain/job-search.ts). force: kullanıcı başlattı, dinlenme süresi beklenmez.
   */
  async plan(workspaceId: string, opts: { count: number; searchProfileId?: string; force?: boolean; actorId?: string | null }) {
    await this.syncBoards(workspaceId);
    const stamp = Date.now();
    let queued = 0;
    for (const profile of await this.activeProfiles(workspaceId, opts.searchProfileId)) {
      const queries = pickJobQueries(buildJobQueries(profile), await this.queryLog(profile.id), { count: opts.count, force: opts.force });
      for (const query of queries) {
        await this.outbox.emit({
          workspaceId,
          eventType: 'jobs.search',
          aggregateId: profile.id,
          dedupKey: `jobs-search:${profile.id}:${query.key}:${stamp}`,
          payload: { queryKey: query.key, actorId: opts.actorId ?? null, userTriggered: opts.force === true },
        });
        queued++;
      }
    }
    return { queued };
  }

  /** Uzaktan ve yurt dışı kapsamına göre ilan panosu kaynaklarını açar ya da kapatır; arama terimleri aranan unvanlardır. */
  async syncBoards(workspaceId: string) {
    const profiles = await this.activeProfiles(workspaceId);
    const terms = [...new Set(profiles.flatMap((p) => p.exactTitles))].slice(0, BOARD_TERMS);
    const wanted = new Map<Connector, boolean>([
      ...REMOTE_BOARDS.map((c) => [c, profiles.some((p) => p.abroadRemote)] as const),
      ...RELOCATION_BOARDS.map((c) => [c, profiles.some((p) => p.abroadRelocation)] as const),
    ]);
    for (const [connector, enabled] of wanted) {
      const existing = await this.prisma.sourceConnector.findFirst({ where: { workspaceId, kind: connector.kind, companyId: null } });
      if (!existing && (!enabled || !terms.length)) continue;
      const source = existing ?? (await this.ingest.aggregatorSource(workspaceId, connector.kind, { terms }));
      const sameTerms = JSON.stringify((source.config as { terms?: string[] } | null)?.terms ?? []) === JSON.stringify(terms);
      if (source.enabled === enabled && sameTerms) continue;
      await this.prisma.sourceConnector.update({ where: { id: source.id }, data: { enabled, config: { terms }, ...(enabled ? { nextRunAt: new Date() } : {}) } });
    }
  }

  /** Planlanmış tek sorguyu çalıştırır ve sorgunun verimini kaydeder. */
  async runQuery(searchProfileId: string, queryKey: string, actorId: string | null = null) {
    const profile = await this.prisma.searchProfile.findUnique({ where: { id: searchProfileId } });
    const query = profile?.active ? buildJobQueries(profile).find((q) => q.key === queryKey) : undefined;
    if (!profile || !query) return { status: 'stale' as const };
    const result = await this.search(profile, { titles: query.titles, location: query.location, platforms: [...PLATFORM_SETS[query.set].platforms] }, actorId, query);
    if (result.status === 'succeeded') await this.saveLog(profile.id, noteJobQuery(await this.queryLog(profile.id), query.key, { returned: result.stats.returned, fresh: result.stats.fresh }));
    return result;
  }

  /** Kullanıcının yazdığı serbest metinle ("Ankara fintech iOS") tek seferlik ilan araması. */
  async runFocus(workspaceId: string, focus: string, actorId: string | null = null) {
    const [profile] = await this.activeProfiles(workspaceId);
    if (!profile) return { status: 'no_profile' as const };
    const platforms = [...PLATFORM_SETS.tr_major.platforms, ...PLATFORM_SETS.tr_boards.platforms, ...PLATFORM_SETS.tr_company.platforms];
    return this.search(profile, { titles: profile.exactTitles, location: searchLocationOf(profile), platforms, focus }, actorId, null);
  }

  private async search(profile: SearchProfile, input: { titles: string[]; location: string; platforms: string[]; focus?: string }, actorId: string | null, query: JobQuery | null) {
    const r = await this.ai.run({
      workspaceId: profile.workspaceId,
      kind: 'job_search',
      input: { ...input, known: await this.knownListings(profile), limit: LISTINGS_PER_QUERY },
      createdById: actorId,
      allowManual: false,
      allowTemplate: false,
      useCache: false,
      entityType: 'SearchProfile',
      entityId: profile.id,
    });
    if (r.status !== 'succeeded') return { status: r.status };
    const listings = ((r.output as { listings?: FoundListing[] }).listings ?? []) as FoundListing[];
    const stats = await this.applyListings(profile, listings, r.taskId);
    await this.learning.record({
      workspaceId: profile.workspaceId,
      kind: 'job_search',
      aiTaskId: r.taskId,
      features: { provider: r.provider, set: query?.set ?? 'focus', scope: query?.scope ?? 'tr', titles: input.titles, location: input.location, focus: input.focus ?? null },
      outcome: { ...stats },
    });
    return { status: 'succeeded' as const, stats };
  }

  /** İstemde "bunlar zaten biliniyor" diye verilen, profille eşleşen açık ilanlar. */
  private async knownListings(profile: SearchProfile) {
    const jobs = await this.prisma.job.findMany({
      where: { workspaceId: profile.workspaceId, status: { in: ['open', 'unknown'] } },
      select: { title: true, company: { select: { name: true } } },
      orderBy: { lastSeenAt: 'desc' },
      take: KNOWN_SCAN,
    });
    return jobs.filter((j) => ['exact', 'adjacent'].includes(classifyTitle(j.title, profile).match)).slice(0, KNOWN_IN_PROMPT).map((j) => `${j.company.name} — ${j.title}`);
  }

  /**
   * Bulunan ilanları süzer, tekilleştirir, sayfası okunabilenleri doğrular ve kaydeder. Yeni firmalar keşif akışına
   * girer (araştırma, adres arama, ortak katalog); firmanın resmî kariyer kaynağı görüldüyse takibe alınır.
   */
  async applyListings(profile: SearchProfile, listings: FoundListing[], taskId: string, opts: ApplyOptions = {}): Promise<JobSearchStats> {
    const workspaceId = profile.workspaceId;
    const rejected: Record<string, number> = {};
    const reject = (reason: string) => (rejected[reason] = (rejected[reason] ?? 0) + 1);
    const candidates = new Map<string, Candidate>();
    for (const listing of listings) {
      const url = normalizeListingUrl(listing.url);
      if (!url) {
        reject('url');
        continue;
      }
      const rejection = listingRejection(profile, { title: listing.title, locationText: listing.location, workMode: listing.workMode });
      if (rejection) {
        reject(rejection);
        continue;
      }
      const externalId = listingExternalId(url);
      candidates.set(externalId, mergeDuplicate(candidates.get(externalId), { ...listing, url, externalId }));
    }
    const source = await this.ingest.aggregatorSource(workspaceId, opts.sourceKind ?? WEB_SEARCH_SOURCE);
    const recorded = await this.prisma.jobListing.findMany({ where: { sourceId: source.id, externalId: { in: [...candidates.keys()] } }, select: { externalId: true } });
    const knownIds = new Set(recorded.map((l) => l.externalId));
    const fresh = [...candidates.values()].filter((c) => !knownIds.has(c.externalId));
    const checks = opts.announced ? new Map<string, PageCheck>() : await this.checkPages(fresh);
    const open = fresh.filter((c) => checks.get(c.externalId)?.state !== 'closed');

    let companies = await this.companyIndex(workspaceId);
    const strangers = new Map<string, Candidate[]>();
    for (const c of open) if (!companies.find(c)) strangers.set(normalizeCompanyName(c.company), [...(strangers.get(normalizeCompanyName(c.company)) ?? []), c]);
    if (strangers.size) {
      await this.research.applyDiscovery(
        workspaceId,
        {
          companies: [...strangers.values()].map((group) => ({
            name: group[0].company,
            domain: group.map(companyDomainOf).find(Boolean) ?? null,
            sectors: [],
            reason: `İlan aramasında bulundu: ${group.map((c) => c.title).join(', ')}`,
            sourceUrl: group[0].url,
            signal: 'open_role',
            careersUrl: group.map((c) => c.careersUrl).find(Boolean) ?? null,
            openRoles: group.map((c) => ({ title: c.title, url: c.url })),
          })),
        },
        taskId,
        { titles: [...profile.exactTitles, ...profile.adjacentTitles], roleLinksAreListings: true },
      );
      companies = await this.companyIndex(workspaceId);
    }

    const raws: RawListing[] = [];
    for (const c of [...open, ...[...candidates.values()].filter((x) => knownIds.has(x.externalId))]) {
      const company = companies.find(c);
      if (!company) continue;
      const posting = checks.get(c.externalId)?.posting;
      const email = c.applyEmail?.trim().toLowerCase();
      raws.push({
        externalId: c.externalId,
        title: c.title.trim(),
        url: c.url,
        applyUrl: c.url,
        locationText: c.location ?? posting?.locationText ?? null,
        workMode: c.workMode && c.workMode !== 'unknown' ? c.workMode : posting?.workMode,
        description: posting?.description ?? null,
        postedAt: dateOf(c.postedAt) ?? posting?.postedAt ?? null,
        validThrough: posting?.validThrough ?? null,
        applyEmail: email && isValidEmail(email) ? email : (posting?.applyEmail ?? null),
        companyName: company.name,
        companyDomain: company.canonicalDomain,
        unverified: !opts.announced && checks.get(c.externalId)?.state !== 'open',
      });
    }
    if (raws.length) await this.ingest.recordFound(source, raws);
    await this.followOfficialSources(workspaceId, open, companies, new Set([...strangers.values()].flat().map((c) => c.externalId)));

    const stats: JobSearchStats = { returned: listings.length, accepted: candidates.size, fresh: open.length, known: knownIds.size, closed: fresh.length - open.length, newCompanies: strangers.size, rejected };
    // Başvurulan firmaların ilanları bu bildirime girmez; her biri ayrıca "başvurduğun firmada yeni ilan" olarak bildirilir.
    const applied = open.length ? await this.appliedCompanies.index(workspaceId) : null;
    const notified = open.filter((c) => {
      const company = companies.find(c);
      return !company || !applied?.match(company);
    });
    if (notified.length) {
      const added = await this.prisma.jobListing.findMany({ where: { sourceId: source.id, externalId: { in: notified.map((c) => c.externalId) } }, select: { jobId: true } });
      const jobIds = [...new Set(added.map((l) => l.jobId))].slice(0, MAX_LINKED_JOBS);
      const sample = notified.slice(0, NOTIFIED_TITLES).map((c) => `${c.company} — ${c.title}`).join(' · ');
      await this.outbox.emit({
        workspaceId,
        eventType: 'notify',
        aggregateId: profile.id,
        dedupKey: `jobs-found:${taskId}`,
        payload: { type: 'new_jobs', title: opts.origin ? `${opts.origin}: ${notified.length} yeni ilan eklendi` : opts.announced ? `İş alarmından ${notified.length} yeni ilan eklendi` : `${notified.length} yeni ilan bulundu`, body: notified.length > NOTIFIED_TITLES ? `${sample} ve ${notified.length - NOTIFIED_TITLES} ilan daha` : sample, link: jobIds.length ? `/jobs?ids=${jobIds.join(',')}` : '/home' },
      });
    }
    return stats;
  }

  /** Bilinen firmanın ilanında resmî kariyer sayfası ya da başvuru panosu görüldüyse takip edilen kaynak olur. */
  private async followOfficialSources(workspaceId: string, listings: Candidate[], companies: Awaited<ReturnType<JobSearchService['companyIndex']>>, alreadyHandled: Set<string>) {
    const linksOf = new Map<string, { links: string[]; careersUrl: string | null }>();
    for (const c of listings) {
      const company = companies.find(c);
      if (!company || alreadyHandled.has(c.externalId)) continue;
      const entry = linksOf.get(company.id) ?? { links: [], careersUrl: null };
      // Tekil ilan sayfası kariyer sayfası yerine geçmez: yalnızca bildirilen kariyer sayfası ve başvuru panosu bağlantıları izlenir.
      entry.links.push(...(c.careersUrl ? [c.careersUrl] : []), ...(detectAtsSource(c.url) ? [c.url] : []));
      entry.careersUrl ??= c.careersUrl ?? null;
      linksOf.set(company.id, entry);
    }
    for (const [companyId, { links, careersUrl }] of linksOf) {
      const company = await this.prisma.company.findFirst({ where: { id: companyId, workspaceId } });
      if (!company) continue;
      await this.research.registerDiscoveredSources(company, links, { explicitCareersUrl: careersUrl }).catch((e) => this.logger.warn(`Kaynak eklenemedi (${company.name}): ${errorMessage(e)}`));
    }
  }

  private async companyIndex(workspaceId: string) {
    const rows: CompanyRef[] = await this.prisma.company.findMany({ where: { workspaceId }, select: { id: true, name: true, canonicalDomain: true } });
    const byDomain = new Map(rows.filter((c) => c.canonicalDomain).map((c) => [c.canonicalDomain!, c]));
    const byName = new Map(rows.map((c) => [normalizeCompanyName(c.name), c]));
    const byKey = new Map<string, CompanyRef[]>();
    for (const c of rows) byKey.set(companyNameKey(c.name), [...(byKey.get(companyNameKey(c.name)) ?? []), c]);
    return {
      /**
       * Önce alan adı, sonra ad. Adın çekirdeğiyle ("… Group") eşleşme yalnızca tek bir aday varsa ve alan adları
       * çelişmiyorsa kabul edilir; aynı grubun farklı şirketleri birbirine karışmasın.
       */
      find(listing: FoundListing): CompanyRef | undefined {
        const domain = companyDomainOf(listing);
        const exact = (domain ? byDomain.get(domain) : undefined) ?? byName.get(normalizeCompanyName(listing.company));
        if (exact) return exact;
        const similar = byKey.get(companyNameKey(listing.company)) ?? [];
        const [only] = similar;
        return similar.length === 1 && !(domain && only.canonicalDomain && only.canonicalDomain !== domain) ? only : undefined;
      },
    };
  }

  private async checkPages(listings: Candidate[]) {
    const checks = new Map<string, PageCheck>();
    for (const listing of listings.slice(0, PAGE_CHECKS_PER_QUERY)) checks.set(listing.externalId, await this.checkPage(listing.url));
    return checks;
  }

  /**
   * İlan sayfasını (robots.txt izin veriyorsa) okur: sayfa yoksa ya da kapandığını söylüyorsa "closed"; geçerli bir
   * JobPosting kaydı varsa "open"; okunamıyorsa ya da yapısal veri yoksa "unverified".
   */
  async checkPage(url: string): Promise<PageCheck> {
    try {
      if (!(await robotsAllows(url))) return { state: 'unverified' };
      const r = await fetchSource(url);
      if (r.state === 'not_found') return { state: 'closed' };
      if (r.state !== 'ok' || !r.res || !/html/.test(r.res.headers['content-type'] ?? '')) return { state: 'unverified' };
      const html = r.res.text();
      if (CLOSED_TEXT.test(stripHtml(html))) return { state: 'closed' };
      const posting = parseJobPostingJsonLd(html, url)[0];
      if (!posting) return { state: 'unverified' };
      const expired = !!posting.validThrough && posting.validThrough.getTime() < Date.now();
      return posting.closedMarker || expired ? { state: 'closed' } : { state: 'open', posting };
    } catch {
      return { state: 'unverified' };
    }
  }

  /**
   * Toplayıcı kaynaklardan gelen ve bir süredir yeniden görülmeyen ilanları yoklar: sayfası kapanmışsa ilan kapanır,
   * açıksa süresi uzar, yoklanamıyorsa belirli bir süre sonra kapanmış sayılır ("geçmişte açmış" sınıfına geçer).
   */
  async expireStale(now = new Date()) {
    const kinds = [...CONNECTORS.values()].filter((c) => c.aggregator).map((c) => c.kind);
    const listings = await this.prisma.jobListing.findMany({
      where: { source: { kind: { in: kinds } }, status: { in: ['open', 'unknown'] }, lastSeenAt: { lt: new Date(now.getTime() - RECHECK_AFTER_DAYS * DAY_MS) } },
      orderBy: { lastSeenAt: 'asc' },
      take: RECHECKS_PER_RUN,
      select: { id: true, jobId: true, workspaceId: true, canonicalUrl: true, lastSeenAt: true, job: { select: { companyId: true } } },
    });
    let closed = 0;
    for (const listing of listings) {
      const check: PageCheck = listing.canonicalUrl ? await this.checkPage(listing.canonicalUrl) : { state: 'unverified' };
      const expired = now.getTime() - listing.lastSeenAt.getTime() > EXPIRE_AFTER_DAYS * DAY_MS;
      if (check.state === 'open') await this.prisma.jobListing.update({ where: { id: listing.id }, data: { lastSeenAt: now } });
      else if (check.state === 'closed' || expired) {
        await this.prisma.jobListing.update({ where: { id: listing.id }, data: { status: 'closed', statusReason: check.state === 'closed' ? 'page_closed' : 'expired_not_seen' } });
        closed++;
      } else continue;
      await this.ingest.refreshJob(listing.jobId);
      await this.outbox.emit({ workspaceId: listing.workspaceId, eventType: 'evaluate.company', aggregateId: listing.job.companyId, dedupKey: `eval-company:${listing.job.companyId}:recheck:${listing.id}:${now.getTime()}`, payload: { companyId: listing.job.companyId } });
    }
    return { checked: listings.length, closed };
  }
}
