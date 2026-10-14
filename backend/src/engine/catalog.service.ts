import { Injectable, Logger } from '@nestjs/common';
import { CatalogCompany, Company, Prisma, SearchProfile, SourceConnector } from '@prisma/client';
import { sha256 } from '../common/crypto';
import { errorMessage } from '../common/errors';
import { OutboxService } from '../common/outbox.service';
import { PrismaService } from '../common/prisma.service';
import {
  CATALOG_LIMITS,
  CatalogContact,
  CatalogFacts,
  CatalogJob,
  catalogKeyOf,
  CatalogOffice,
  CatalogSource,
  matchCatalogCompany,
  mergeCatalog,
  pastJobsFor,
  recentOpenJobsFor,
} from '../domain/catalog';
import { LEGACY_CLASSIFICATION_CATEGORY } from '../domain/address-book';
import { SENDABLE_CONTACT_KINDS, SUGGESTED_ONLY_KINDS } from '../domain/contacts';
import { detectLocation } from '../domain/geo';
import { listingExternalId, normalizeListingUrl, WEB_SEARCH_SOURCE } from '../domain/job-search';
import { normalizeTitle } from '../domain/titles';
import { AddressBookService } from './address-book.service';
import { careersLinkOfSource, DISCOVERED_SOURCE_KINDS, discoveredSourceData, isDiscoveredSourceKind } from './connectors/defaults';
import { IngestService } from './ingest.service';

const BACKFILL_KEY = 'catalog:backfill:v1';
const SKIP_KEY = (workspaceId: string) => `catalog:skip:${workspaceId}`;
const CATALOG_ORIGIN = 'catalog';
/** Kullanıcının hedef listesi olarak sisteme giren firmalar; aradığı unvanlar için bulunmuş sayılırlar. */
const TARGETED_ORIGINS = ['discovery', 'excel', CATALOG_ORIGIN];
const KNOWN_OFFICE_CONFIDENCE = ['medium', 'high'];
const SHAREABLE_CONTACT_KINDS = [...SENDABLE_CONTACT_KINDS, ...SUGGESTED_ONLY_KINDS];
const SENT_STATES = ['provider_accepted', 'submission_unknown', 'replied', 'bounced', 'outcome_recorded'];
const SEED_LIMIT = 400;
const PAST_JOBS_PER_COMPANY = 5;
const OPEN_JOBS_PER_COMPANY = 5;

const PUBLISH_INCLUDE = {
  offices: { where: { locationConfidence: { in: KNOWN_OFFICE_CONFIDENCE } }, select: { label: true, kind: true, city: true, district: true, address: true } },
  contacts: { where: { suppressed: false, kind: { in: SHAREABLE_CONTACT_KINDS } }, select: { email: true, kind: true, sourceUrl: true } },
  sources: { where: { enabled: true, kind: { in: DISCOVERED_SOURCE_KINDS } }, select: { kind: true, config: true } },
  jobs: {
    orderBy: { lastSeenAt: 'desc' },
    take: CATALOG_LIMITS.jobs,
    select: { title: true, status: true, firstSeenAt: true, lastSeenAt: true, closedAt: true, applyUrl: true, locationText: true, listings: { select: { canonicalUrl: true }, take: 1 } },
  },
} satisfies Prisma.CompanyInclude;

type PublishedCompany = Prisma.CompanyGetPayload<{ include: typeof PUBLISH_INCLUDE }>;
type ResearchDates = { contactsSearchedAt?: string; officesSearchedAt?: string };

export interface PullResult {
  contacts: number;
  offices: number;
  size: boolean;
}

const NOTHING_PULLED: PullResult = { contacts: 0, offices: 0, size: false };

function dateOf(iso: string | undefined) {
  const at = iso ? new Date(iso) : null;
  return at && !Number.isNaN(at.getTime()) ? at : null;
}

function isShareable(c: { excluded: boolean; origin: string; lastResearchedAt: Date | null }) {
  return !c.excluded && (TARGETED_ORIGINS.includes(c.origin) || !!c.lastResearchedAt);
}

function factsOfCompany(c: PublishedCompany): CatalogFacts | null {
  const key = catalogKeyOf(c);
  if (!key) return null;
  const report = c.researchReport as { summary?: string | null } | null;
  const meta = (c.researchMeta ?? {}) as ResearchDates;
  return {
    key,
    name: c.name,
    normalizedName: c.normalizedName,
    canonicalDomain: c.canonicalDomain,
    website: c.website,
    careersUrl: c.careersUrl,
    linkedinUrl: c.linkedinUrl,
    groupName: c.groupName,
    sectors: c.sectors,
    services: c.services,
    summary: report?.summary?.trim() || null,
    employeeRange: c.employeeRange,
    employeeCount: c.employeeCount,
    cities: [],
    offices: c.offices,
    sources: c.sources.filter(careersLinkOfSource).map((s) => ({ kind: s.kind, config: (s.config ?? {}) as Record<string, string> })),
    contacts: c.contacts.map((x) => ({ email: x.email.toLowerCase(), kind: x.kind, sourceUrl: x.sourceUrl })),
    jobs: c.jobs.map((j) => ({
      title: j.title,
      status: j.status === 'closed' ? ('closed' as const) : ('open' as const),
      firstSeenAt: j.firstSeenAt.toISOString(),
      lastSeenAt: j.lastSeenAt.toISOString(),
      closedAt: j.closedAt?.toISOString() ?? null,
      url: j.listings[0]?.canonicalUrl ?? j.applyUrl,
      location: j.locationText,
    })),
    discoveredFor: [],
    researchedAt: c.lastResearchedAt,
    contactsSearchedAt: dateOf(meta.contactsSearchedAt),
    officesSearchedAt: dateOf(meta.officesSearchedAt),
  };
}

function factsOfRow(row: CatalogCompany): CatalogFacts {
  return {
    key: row.key,
    name: row.name,
    normalizedName: row.normalizedName,
    canonicalDomain: row.canonicalDomain,
    website: row.website,
    careersUrl: row.careersUrl,
    linkedinUrl: row.linkedinUrl,
    groupName: row.groupName,
    sectors: row.sectors,
    services: row.services,
    summary: row.summary,
    employeeRange: row.employeeRange,
    employeeCount: row.employeeCount,
    cities: row.cities,
    offices: (row.offices ?? []) as unknown as CatalogOffice[],
    sources: (row.sources ?? []) as unknown as CatalogSource[],
    contacts: (row.contacts ?? []) as unknown as CatalogContact[],
    jobs: (row.jobs ?? []) as unknown as CatalogJob[],
    discoveredFor: row.discoveredFor,
    researchedAt: row.researchedAt,
    contactsSearchedAt: row.contactsSearchedAt,
    officesSearchedAt: row.officesSearchedAt,
  };
}

function rowDataOf(facts: CatalogFacts) {
  const json = (value: unknown) => value as Prisma.InputJsonValue;
  return { ...facts, offices: json(facts.offices), sources: json(facts.sources), contacts: json(facts.contacts), jobs: json(facts.jobs) };
}

function isUniqueViolation(e: unknown) {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
}

/**
 * Ortak firma kataloğu. Bir çalışma alanında bulunan firmanın kamuya açık bilgileri (ad, site, ofis, yayımlanmış
 * başvuru adresleri, görülen ilan unvanları, çalışan sayısı) burada birikir; kriterleri uyan başka bir çalışma alanına
 * yapay zekâ çağrısı yapılmadan aktarılır. Kimin başvurduğu, notlar, taslaklar ve role özel analiz paylaşılmaz.
 */
@Injectable()
export class CatalogService {
  private readonly logger = new Logger('Catalog');

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly addressBook: AddressBookService,
    private readonly ingest: IngestService,
  ) {}

  private async findRow(c: { catalogId: string | null; canonicalDomain: string | null; normalizedName: string }) {
    const linked = c.catalogId ? await this.prisma.catalogCompany.findUnique({ where: { id: c.catalogId } }) : null;
    if (linked) return linked;
    const byDomain = c.canonicalDomain ? await this.prisma.catalogCompany.findUnique({ where: { key: c.canonicalDomain } }) : null;
    if (byDomain) return byDomain;
    if (!catalogKeyOf({ canonicalDomain: null, normalizedName: c.normalizedName })) return null;
    return this.prisma.catalogCompany.findFirst({ where: { normalizedName: c.normalizedName, ...(c.canonicalDomain ? { canonicalDomain: null } : {}) }, orderBy: { createdAt: 'asc' } });
  }

  /** Firmanın paylaşılabilir bilgilerini kataloğa işler ve firmayı katalog kaydına bağlar. */
  async publish(companyId: string, opts: { discoveredFor?: string[] } = {}): Promise<string | null> {
    const company = await this.prisma.company.findUnique({ where: { id: companyId }, include: PUBLISH_INCLUDE });
    if (!company || !isShareable(company)) return null;
    const incoming = factsOfCompany(company);
    if (!incoming) return null;
    const row = await this.findRow(company);
    const existing = row ? factsOfRow(row) : null;
    const dead = await this.addressBook.deadAmong([...incoming.contacts, ...(existing?.contacts ?? [])].map((c) => c.email));
    const merged = mergeCatalog(existing, incoming, { dead, discoveredFor: opts.discoveredFor });
    const sizeChanged = !!merged.employeeRange && merged.employeeRange !== existing?.employeeRange;
    const data = { ...rowDataOf(merged), ...(sizeChanged ? { employeeCheckedAt: new Date() } : {}) };
    let saved: CatalogCompany;
    try {
      saved = row ? await this.prisma.catalogCompany.update({ where: { id: row.id }, data }) : await this.prisma.catalogCompany.create({ data });
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      const winner = await this.prisma.catalogCompany.findUnique({ where: { key: merged.key } });
      if (!winner) return null;
      saved = await this.prisma.catalogCompany.update({ where: { id: winner.id }, data: rowDataOf(mergeCatalog(factsOfRow(winner), incoming, { dead, discoveredFor: opts.discoveredFor })) });
    }
    if (company.catalogId !== saved.id) await this.prisma.company.update({ where: { id: company.id }, data: { catalogId: saved.id } });
    await this.addressBook.noteFound(incoming.contacts, company);
    return saved.id;
  }

  /** Katalogdaki bilgiyle firmanın eksiklerini tamamlar (başvuru adresi, ofis, çalışan sayısı); yapay zekâ çağrısı yapmaz. */
  async pull(companyId: string): Promise<PullResult> {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      include: { contacts: { select: { email: true } }, offices: { where: { locationConfidence: { in: KNOWN_OFFICE_CONFIDENCE } }, select: { id: true } } },
    });
    const row = company ? await this.findRow(company) : null;
    if (!company || !row) return NOTHING_PULLED;
    const facts = factsOfRow(row);
    const known = new Set(company.contacts.map((c) => c.email.toLowerCase()));
    const contacts = await this.addContacts(company.id, facts.contacts.filter((c) => !known.has(c.email)));
    const offices = company.offices.length ? 0 : await this.addOffices(company.id, facts.offices);
    const takeSize = !company.employeeRange && !!facts.employeeRange;
    const patch: Prisma.CompanyUpdateInput = {
      ...(company.catalogId !== row.id ? { catalogId: row.id } : {}),
      ...(takeSize ? { employeeRange: facts.employeeRange, employeeCount: facts.employeeCount } : {}),
      ...(!company.linkedinUrl && facts.linkedinUrl ? { linkedinUrl: facts.linkedinUrl } : {}),
      ...(!company.careersUrl && facts.careersUrl ? { careersUrl: facts.careersUrl } : {}),
      ...(!company.groupName && facts.groupName ? { groupName: facts.groupName } : {}),
    };
    if (Object.keys(patch).length) await this.prisma.company.update({ where: { id: company.id }, data: patch });
    if (offices) await this.outbox.emit({ workspaceId: company.workspaceId, eventType: 'evaluate.company', aggregateId: company.id, dedupKey: `eval-company:${company.id}:catalog:${Date.now()}`, payload: { companyId: company.id } });
    return { contacts, offices, size: takeSize };
  }

  /** Önce firmanın bildiklerini kataloğa yazar, sonra katalogdaki eksiklerini alır. */
  async sync(companyId: string): Promise<PullResult> {
    await this.publish(companyId);
    return this.pull(companyId);
  }

  async pullWorkspace(workspaceId: string) {
    const companies = await this.prisma.company.findMany({ where: { workspaceId, excluded: false }, select: { id: true } });
    const total = { contacts: 0, offices: 0, sizes: 0 };
    for (const c of companies) {
      const pulled = await this.pull(c.id);
      total.contacts += pulled.contacts;
      total.offices += pulled.offices;
      total.sizes += Number(pulled.size);
    }
    return total;
  }

  private async addContacts(companyId: string, contacts: CatalogContact[]) {
    if (!contacts.length) return 0;
    const dead = await this.addressBook.deadAmong(contacts.map((c) => c.email));
    const usable = contacts.filter((c) => !dead.has(c.email));
    if (usable.length) await this.ingest.saveContacts({ companyId } as SourceConnector, usable, CATALOG_ORIGIN);
    return usable.length;
  }

  private async addOffices(companyId: string, offices: CatalogOffice[]) {
    if (!offices.length) return 0;
    await this.prisma.office.deleteMany({ where: { companyId, locationConfidence: 'low' } });
    await this.prisma.office.createMany({ data: offices.map((o) => ({ companyId, label: o.label ?? 'Ofis', kind: o.kind, city: o.city, district: o.district, address: o.address, locationConfidence: 'medium' })) });
    return offices.length;
  }

  private async skipped(workspaceId: string): Promise<Set<string>> {
    const kv = await this.prisma.keyValue.findUnique({ where: { key: SKIP_KEY(workspaceId) } });
    return new Set((kv?.value as string[] | null) ?? []);
  }

  /** Kullanıcının sildiği firma ortak katalogdan bu çalışma alanına yeniden önerilmez. */
  async forget(workspaceId: string, companyId: string) {
    const company = await this.prisma.company.findFirst({ where: { id: companyId, workspaceId }, select: { catalogId: true, canonicalDomain: true, normalizedName: true } });
    const row = company ? await this.findRow(company) : null;
    if (!row) return;
    const value = [...(await this.skipped(workspaceId)).add(row.id)];
    await this.prisma.keyValue.upsert({ where: { key: SKIP_KEY(workspaceId) }, create: { key: SKIP_KEY(workspaceId), value }, update: { value } });
  }

  /**
   * Katalogda bulunan ve bu arama profiline uyan firmaları çalışma alanına ekler: firma, ofisler, geçerli başvuru
   * adresleri, takip edilecek kariyer kaynakları ve profille eşleşen kapanmış ilanlar. Yeni ilanlar kaynakların
   * taranmasıyla gelir.
   */
  async seedWorkspace(searchProfileId: string, opts: { limit?: number } = {}) {
    const profile = await this.prisma.searchProfile.findUnique({ where: { id: searchProfileId } });
    if (!profile?.active || profile.exactTitles.length + profile.adjacentTitles.length === 0) return { matched: 0, created: 0 };
    const workspaceId = profile.workspaceId;
    const [own, skipped, rows] = await Promise.all([
      this.prisma.company.findMany({ where: { workspaceId }, select: { canonicalDomain: true, normalizedName: true, catalogId: true } }),
      this.skipped(workspaceId),
      this.prisma.catalogCompany.findMany(),
    ]);
    const ownDomains = new Set(own.map((c) => c.canonicalDomain).filter(Boolean));
    const ownNames = new Set(own.map((c) => c.normalizedName));
    const ownCatalogIds = new Set(own.map((c) => c.catalogId).filter(Boolean));
    const candidates = rows
      .filter((r) => !ownCatalogIds.has(r.id) && !skipped.has(r.id) && !ownNames.has(r.normalizedName) && !(r.canonicalDomain && ownDomains.has(r.canonicalDomain)))
      .map((row) => ({ row, facts: factsOfRow(row) }))
      .map((c) => ({ ...c, match: matchCatalogCompany(profile, c.facts) }))
      .filter((c) => c.match)
      .sort((a, b) => b.match!.score - a.match!.score)
      .slice(0, opts.limit ?? SEED_LIMIT);
    let created = 0;
    for (const { row, facts } of candidates) {
      if (ownNames.has(facts.normalizedName)) continue;
      try {
        if (!(await this.adopt(profile, row.id, facts))) continue;
        ownNames.add(facts.normalizedName);
        created++;
      } catch (e) {
        this.logger.warn(`Katalog firması eklenemedi (${facts.name}): ${errorMessage(e)}`);
      }
    }
    if (created) {
      await this.outbox.emit({
        workspaceId,
        eventType: 'notify',
        aggregateId: profile.id,
        dedupKey: `catalog-seed:${profile.id}:${Date.now()}`,
        payload: { type: 'catalog_seed', title: `${created} firma ortak listeden eklendi`, body: 'Daha önce bulunmuş ve aradığın pozisyonlara uyan firmalar yeni bir arama yapılmadan listene eklendi.', link: '/home?sira=yeni' },
      });
    }
    return { matched: candidates.length, created };
  }

  private async adopt(profile: SearchProfile, catalogId: string, facts: CatalogFacts): Promise<Company | null> {
    const now = new Date();
    const searched: ResearchDates = {
      ...(facts.contactsSearchedAt ? { contactsSearchedAt: facts.contactsSearchedAt.toISOString() } : {}),
      ...(facts.officesSearchedAt ? { officesSearchedAt: facts.officesSearchedAt.toISOString() } : {}),
    };
    let company: Company;
    try {
      company = await this.prisma.company.create({
        data: {
          workspaceId: profile.workspaceId,
          name: facts.name,
          normalizedName: facts.normalizedName,
          canonicalDomain: facts.canonicalDomain,
          website: facts.website ?? (facts.canonicalDomain ? `https://${facts.canonicalDomain}` : null),
          careersUrl: facts.careersUrl,
          linkedinUrl: facts.linkedinUrl,
          groupName: facts.groupName,
          sectors: facts.sectors,
          services: facts.services,
          employeeRange: facts.employeeRange,
          employeeCount: facts.employeeCount,
          origin: CATALOG_ORIGIN,
          catalogId,
          importRef: `catalog:${catalogId}`,
          lastResearchedAt: now,
          researchMeta: searched,
          ...(facts.summary ? { researchReport: { status: CATALOG_ORIGIN, summary: facts.summary, at: now.toISOString() } } : {}),
        },
      });
    } catch (e) {
      if (isUniqueViolation(e)) return null;
      throw e;
    }
    await this.addOffices(company.id, facts.offices);
    await this.addContacts(company.id, facts.contacts);
    for (const source of facts.sources) {
      if (!isDiscoveredSourceKind(source.kind) || !careersLinkOfSource(source)) continue;
      await this.prisma.sourceConnector.create({ data: { workspaceId: company.workspaceId, companyId: company.id, ...discoveredSourceData(source.kind, company.name, source.config), nextRunAt: now } });
    }
    for (const job of pastJobsFor(profile, facts.jobs).slice(0, PAST_JOBS_PER_COMPANY)) await this.addPastJob(company, catalogId, job);
    await this.addReportedJobs(company, recentOpenJobsFor(profile, facts.jobs).slice(0, OPEN_JOBS_PER_COMPANY));
    await this.outbox.emit({ workspaceId: company.workspaceId, eventType: 'evaluate.company', aggregateId: company.id, dedupKey: `eval-company:${company.id}:catalog-seed`, payload: { companyId: company.id } });
    return company;
  }

  /** Katalogda açık görünen ilanlar bu çalışma alanında doğrulanmadığı için "teyit gerekli" olarak kaydedilir. */
  private async addReportedJobs(company: Company, jobs: CatalogJob[]) {
    const listings = jobs.flatMap((job) => {
      const url = normalizeListingUrl(job.url);
      return url ? [{ externalId: listingExternalId(url), title: job.title, url, applyUrl: url, locationText: job.location, companyName: company.name, companyDomain: company.canonicalDomain, unverified: true }] : [];
    });
    if (listings.length) await this.ingest.recordFound(await this.ingest.aggregatorSource(company.workspaceId, WEB_SEARCH_SOURCE), listings);
  }

  private addPastJob(company: Company, catalogId: string, job: CatalogJob) {
    const location = detectLocation(job.location);
    const closedAt = new Date(job.closedAt ?? job.lastSeenAt);
    return this.prisma.job.create({
      data: {
        workspaceId: company.workspaceId,
        companyId: company.id,
        canonicalKey: `catalog:${catalogId}:${sha256(`${normalizeTitle(job.title)}|${job.firstSeenAt}`).slice(0, 24)}`,
        title: job.title,
        normalizedTitle: normalizeTitle(job.title),
        locationText: job.location,
        district: location.district,
        city: location.city,
        status: 'closed',
        statusReason: 'catalog_history',
        firstSeenAt: new Date(job.firstSeenAt),
        lastSeenAt: new Date(job.lastSeenAt),
        closedAt,
        applyUrl: job.url,
      },
    });
  }

  async backfilled() {
    return !!(await this.prisma.keyValue.findUnique({ where: { key: BACKFILL_KEY } }));
  }

  /**
   * Tek seferlik geçiş: var olan firmalar kataloğa, gönderilmiş başvurular ve dönüşleri adres siciline işlenir;
   * ardından çalışma alanları katalogdaki eksiklerini alır. Yarıda kalırsa yeniden çalıştırmak güvenlidir.
   */
  async backfill() {
    if (await this.backfilled()) return { skipped: true };
    const profiles = await this.prisma.searchProfile.findMany({ where: { active: true }, orderBy: { createdAt: 'asc' }, select: { workspaceId: true, exactTitles: true, adjacentTitles: true } });
    const titlesOf = new Map<string, string[]>();
    for (const p of profiles) if (!titlesOf.has(p.workspaceId)) titlesOf.set(p.workspaceId, [...p.exactTitles, ...p.adjacentTitles]);
    const companies = await this.prisma.company.findMany({ where: { excluded: false }, orderBy: { createdAt: 'asc' }, select: { id: true, workspaceId: true, origin: true } });
    let published = 0;
    for (const c of companies) {
      const discoveredFor = TARGETED_ORIGINS.includes(c.origin) ? titlesOf.get(c.workspaceId) : undefined;
      if (await this.publish(c.id, { discoveredFor })) published++;
    }
    const attempts = await this.prisma.applicationAttempt.findMany({ where: { channel: 'email', toEmail: { not: null }, state: { in: SENT_STATES } }, orderBy: { createdAt: 'asc' }, select: { id: true } });
    for (const attempt of attempts) {
      await this.addressBook.noteSent(attempt.id);
      const inbound = await this.prisma.inboundMessage.findMany({ where: { attemptId: attempt.id }, orderBy: { receivedAt: 'asc' }, select: { category: true, classification: true } });
      for (const m of inbound) await this.addressBook.noteOutcome(attempt.id, m.category ?? LEGACY_CLASSIFICATION_CATEGORY[m.classification]);
    }
    await this.addressBook.settle();
    const pulled = { contacts: 0, offices: 0, sizes: 0 };
    for (const workspaceId of new Set(companies.map((c) => c.workspaceId))) {
      const r = await this.pullWorkspace(workspaceId);
      pulled.contacts += r.contacts;
      pulled.offices += r.offices;
      pulled.sizes += r.sizes;
    }
    const summary = { published, sends: attempts.length, pulled, at: new Date().toISOString() };
    await this.prisma.keyValue.upsert({ where: { key: BACKFILL_KEY }, create: { key: BACKFILL_KEY, value: summary }, update: { value: summary } });
    this.logger.log(`Ortak hafıza geçişi tamamlandı: ${published} firma, ${attempts.length} gönderim, ${pulled.contacts} adres paylaşıldı`);
    return summary;
  }
}
