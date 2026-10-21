import { Injectable, Logger } from '@nestjs/common';
import { Company, Prisma, SourceConnector } from '@prisma/client';
import * as cheerio from 'cheerio';
import { promises as dns } from 'dns';
import { env } from '../common/env';
import { OutboxService } from '../common/outbox.service';
import { PrismaService } from '../common/prisma.service';
import { parseEmployees } from '../domain/company-size';
import {
  CandidateReview,
  genericGuess,
  isOffTopicAddress,
  MANUAL_ONLY_KINDS,
  mergeCandidates,
  needsReview,
  pageMentionsEmail,
  pickGenericGuesses,
  ResearchCandidate,
  roleGuessesFor,
  settleCandidate,
  SettledContact,
  settleProbedGuess,
  SourceCheck,
  sourceIsReadable,
  websiteDomainFor,
} from '../domain/contact-research';
import { contactSearchPlan, rememberedDepth, SEARCH_RETRY_DAYS, SEARCH_VERSION, SearchDepth, SearchRequest } from '../domain/contact-search';
import { CANDIDATE_HR_KIND, classifyPublishedEmail, cleanEmail, domainMatches, GROUP_HR_KIND, isUnverifiableSource, isValidEmail, SENDABLE_CONTACT_KINDS } from '../domain/contacts';
import { detectLocation } from '../domain/geo';
import { isTurkishUrl, normalizeCompanyName, normalizeDomain, stripHtml, truncate } from '../domain/text';
import { AddressBookService } from './address-book.service';
import { AiService } from './ai/ai.service';
import { CatalogService } from './catalog.service';
import { CompanyScoringService } from './company-scoring.service';
import { assertSafeUrl } from '../domain/ssrf';
import { detectAtsSource } from './connectors/ats-detect';
import { discoveredSourceData } from './connectors/defaults';
import { fetchSource, robotsAllows } from './connectors/http';
import { IngestService } from './ingest.service';
import { LearnedModelsService } from './learned-models.service';
import { LearningService } from './learning.service';
import { probeMailboxes } from './mail/smtp-probe';

const RECENT_RESEARCH_MS = 15 * 60_000;
const DAY_MS = 86_400_000;
export const REPORT_REFRESH_DAYS = 30;
export const DETAILS_RETRY_DAYS = SEARCH_RETRY_DAYS;
/** Kaynağında doğrulanmış adres bu süreden sonra kaynağı yeniden okunarak teyit edilir. */
const REVERIFY_AFTER_DAYS = 30;
/** Kaynağı okunamayan adresin teyidi bu kadar sonra yeniden denenir. */
const REVERIFY_RETRY_DAYS = 7;
const REVERIFY_BATCH = 30;
const READABLE_PAGE = /(html|text\/|json|xml)/i;
const APPLIED_STATES = ['queued', 'sending', 'provider_accepted', 'submission_unknown', 'replied', 'bounced', 'outcome_recorded'];
export const SIZE_RETRY_DAYS = 45;
/** Tek yapay zekâ çağrısında çalışan sayısı sorulan firma sayısı. */
export const SIZE_BATCH = 12;
const LINKEDIN_COMPANY_URL = /^https:\/\/([a-z]{2,3}\.)?linkedin\.com\/company\/[^/?#\s]+/i;
const SEARCH_PAUSE_PREFIX = 'search:paused:';
const COMPANY_LOOKUP_PREFIX = 'company-lookup:';

const ADDRESS_PATTERN = /[^.\n]{0,80}\b(?:mah(?:\.|allesi)|cad(?:\.|desi)|sok(?:\.|ak)|blv\.|bulvar[ıi])[^\n]{0,120}?\b(?:no\s*[:.]?\s*\d+[^\n]{0,60}|\d{5}[^\n]{0,40})/gi;
const MAX_SOURCE_CHARS = 2500;
const MAX_TOTAL_SOURCE_CHARS = 10_000;

export function extractAddresses(html: string, text: string): string[] {
  const found = new Set<string>();
  const $ = cheerio.load(html);
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const visit = (node: any): void => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) return node.forEach(visit);
        const a = node.address;
        if (a && typeof a === 'object' && !Array.isArray(a)) {
          const line = [a.streetAddress, a.addressLocality, a.addressRegion, a.postalCode].filter(Boolean).join(', ');
          if (line.length > 10) found.add(line);
        } else if (typeof a === 'string' && a.length > 10) found.add(a);
        Object.values(node).forEach(visit);
      };
      visit(JSON.parse($(el).text()));
    } catch {
      return;
    }
  });
  for (const m of text.matchAll(ADDRESS_PATTERN)) found.add(m[0].replace(/\s+/g, ' ').trim());
  return [...found].filter((a) => a.length >= 15 && a.length <= 300).slice(0, 5);
}

export function pruneSources(pages: { url: string; text: string }[]) {
  const lineCounts = new Map<string, number>();
  const linesOf = (t: string) => t.split(/\n+|(?<=[.!?])\s+/).map((l) => l.trim()).filter(Boolean);
  for (const p of pages) for (const l of new Set(linesOf(p.text))) lineCounts.set(l, (lineCounts.get(l) ?? 0) + 1);
  let budget = MAX_TOTAL_SOURCE_CHARS;
  const out: { url: string; text: string }[] = [];
  for (const p of pages) {
    if (budget <= 0) break;
    const unique = linesOf(p.text).filter((l) => pages.length < 2 || (lineCounts.get(l) ?? 0) < 2).join(' ');
    const text = unique.slice(0, Math.min(MAX_SOURCE_CHARS, budget));
    if (text.length < 40) continue;
    budget -= text.length;
    out.push({ url: p.url, text });
  }
  return out;
}

export const DISCOVERY_SEGMENTS = [
  'Fintech, bankacılık, ödeme ve sigorta',
  'E-ticaret, perakende ve pazar yerleri',
  'Mobil oyun stüdyoları ve yayıncıları',
  'Ulaşım, lojistik, hızlı teslimat ve mobilite',
  'Sağlık, eğitim, medya ve SaaS ürün şirketleri',
  'Telekom, büyük holdinglerin ve kurumsal şirketlerin dijital/teknoloji birimleri',
  'Yazılım evleri, dijital ajanslar ve dış kaynak yazılım firmaları',
  'Yatırım almış girişimler (seed – Series C) ve uluslararası şirketlerin İstanbul ofisleri',
];
const DISCOVERY_LOG_PREFIX = 'discovery:log:';
const SEGMENT_REST_DAYS = 3;
const SEGMENT_EXHAUSTED_BELOW = 2;
const KNOWN_DOMAINS_IN_PROMPT = 150;

export type SegmentLog = Record<string, { at: string; created: number }>;

export function pickSegments(log: SegmentLog, opts: { count?: number; skipExhausted?: boolean; now?: number } = {}) {
  const now = opts.now ?? Date.now();
  const rested = (s: string) => {
    const e = log[s];
    return !e || now - new Date(e.at).getTime() > SEGMENT_REST_DAYS * DAY_MS || e.created >= SEGMENT_EXHAUSTED_BELOW;
  };
  const byOldest = [...DISCOVERY_SEGMENTS].sort((a, b) => new Date(log[a]?.at ?? 0).getTime() - new Date(log[b]?.at ?? 0).getTime());
  const candidates = opts.skipExhausted ? byOldest.filter(rested) : byOldest;
  const chosen = candidates.length ? candidates : byOldest.slice(0, 2);
  return opts.count ? chosen.slice(0, opts.count) : chosen;
}

const RECRUITING_PURPOSES = ['hr', 'recruiting', 'careers'];
const RECRUITING_KINDS = ['official_hr', 'job_apply', 'named_recruiter'];
const SENDABLE_FOUND_KINDS = [...RECRUITING_KINDS, 'general'];
/** Denetçiye en fazla bu kadar aday gider; fazlası denetlenmemiş kurallarla kaydedilir. */
const MAX_REVIEWED = 30;
const MAX_CANDIDATES = 40;
const MAX_SOURCE_PAGES = 25;
const MAX_STORED_FOR_REVIEW = 15;
const MAX_KNOWN_IN_PROMPT = 30;
/** Daha önce kaydedilmiş ama amacı belirsiz kalmış adresler derin aramada denetçiye yeniden sorulur. */
const REVIEWABLE_STORED_KINDS = ['other', 'guessed'];
const RELIABLE_SCORE = 60;

/** Posta sunucusuna kendini tanıtırken kullanılan ad: ayarlanmamışsa uygulamanın dışarıdan erişilen alan adı. */
function probeHelo() {
  const configured = env().SMTP_PROBE_HELO;
  if (configured) return configured;
  const host = normalizeDomain(env().APP_PUBLIC_URL);
  return host && host !== 'localhost' ? host : undefined;
}

export interface DetailsOptions extends Partial<SearchRequest> {
  /** Geri dönmüş ya da kullanıcının istemediği adresler: modele "bunların dışındakileri ara" diye verilir. */
  avoidEmails?: string[];
  /** Firma sitesi az önce tarandıysa (firma raporu) yeniden taranmaz. */
  skipCrawl?: boolean;
}

type HarvestContact = { email: string; sourceUrl?: string | null; purpose?: string | null; roleType?: string | null; name?: string | null; title?: string | null; origin?: string | null; evidence?: string | null };
type HarvestOutput = {
  website?: string | null;
  contacts: HarvestContact[];
  group?: GroupInfo | null;
  offices: { label?: string | null; city?: string | null; district?: string | null; address?: string | null; sourceUrl?: string | null }[];
  employees?: string | null;
};

type FoundContact = { email: string; sourceUrl: string; purpose?: string | null };

/** Eski sosyal medya paylaşımından gelen ve firma alan adında olmayan İK adresi yalnızca öneri olur (kullanıcı onayıyla kullanılır). */
function foundContactKind(c: FoundContact, company: { canonicalDomain: string | null; aliases: string[] } | null) {
  const kind = contactKindFor(c.email, c.purpose);
  const suggestedOnly = SENDABLE_FOUND_KINDS.includes(kind) && isUnverifiableSource(c.sourceUrl) && !domainMatches(cleanEmail(c.email), company?.canonicalDomain, company?.aliases ?? []);
  return suggestedOnly ? CANDIDATE_HR_KIND : kind;
}

function contactKindFor(email: string, purpose?: string | null) {
  const kind = classifyPublishedEmail(cleanEmail(email)).kind;
  return kind === 'other' && purpose && RECRUITING_PURPOSES.includes(purpose) ? 'named_recruiter' : kind;
}

type GroupInfo = { name: string; website?: string | null; hrEmail?: string | null; sourceUrl?: string | null };

export type ResearchMeta = { reportAt?: string; contactsSearchedAt?: string; contactsDepth?: SearchDepth; contactsEscalated?: boolean; contactsVersion?: number; contactsFound?: boolean; officesSearchedAt?: string; officesFound?: boolean; sizeSearchedAt?: string };

/** Derin arama yapıldı ve gönderilebilir adres çıkmadı: yeniden deneme süresi dolana kadar yalnızca diğer başvuru kanalları gösterilir. */
export function addressSearchExhausted(meta: unknown, now = Date.now()) {
  const m = (meta ?? {}) as ResearchMeta;
  return rememberedDepth(m) === 'max' && contactSearchPlan(m, { deep: true }, now).skip === 'exhausted';
}

type SizeAnswer = { ref: string; employees?: string | null; linkedinUrl?: string | null };

export function detailsNeeded(c: { researchMeta: unknown; hrContacts: number; knownOffices: number }, now = Date.now()) {
  const meta = (c.researchMeta ?? {}) as ResearchMeta;
  const due = (at?: string) => !at || now - new Date(at).getTime() > DETAILS_RETRY_DAYS * DAY_MS;
  return (c.hrContacts === 0 && due(meta.contactsSearchedAt)) || (c.knownOffices === 0 && due(meta.officesSearchedAt));
}
const INTERESTING = /(about|hakk|biz-kim|kimiz|work|works|isler|işler|projeler|projects|portfolio|clients|musteri|müşteri|referans|awards|odul|ödül|team|ekip|kariyer|career|jobs|join|iletisim|iletişim|contact)/i;
const CAREERS = /(kariyer|career|careers|jobs|join-us|bize-katil|acik-pozisyon)/i;

@Injectable()
export class ResearchService {
  private readonly logger = new Logger('Research');

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
    private readonly scoring: CompanyScoringService,
    private readonly ingest: IngestService,
    private readonly outbox: OutboxService,
    private readonly catalog: CatalogService,
    private readonly addressBook: AddressBookService,
    private readonly learning: LearningService,
    private readonly models: LearnedModelsService,
  ) {}

  /** Resmî siteden izinli sayfaları okur; kariyer/ATS bağlantılarını kaynak olarak ekler; kaynaklı rapor üretir. */
  async researchCompany(companyId: string, actorId: string | null = null) {
    const company = await this.prisma.company.findUnique({ where: { id: companyId } });
    if (!company) return null;
    if (company.lastResearchedAt && Date.now() - company.lastResearchedAt.getTime() < RECENT_RESEARCH_MS) return { status: 'recent' };
    await this.catalog.sync(company.id);
    const sources: { id: string; url: string; excerpt: string }[] = [];
    const contacts: { email: string; sourceUrl: string }[] = [];
    const base = company.website ?? (company.canonicalDomain ? `https://${company.canonicalDomain}` : null);
    if (base) {
      const pages = await this.crawlSite(company, base);
      pruneSources(pages).forEach((p, i) => sources.push({ id: `S${i + 1}`, url: p.url, excerpt: p.text }));
      const siteAddresses = pages.flatMap((p) => p.addresses.map((address) => ({ address, sourceUrl: p.url })));
      const knownOffices = await this.prisma.office.count({ where: { companyId: company.id, locationConfidence: { in: ['medium', 'high'] } } });
      if (!knownOffices && siteAddresses.length) {
        await this.applyOffices(
          company.id,
          siteAddresses.slice(0, 3).map((a) => {
            const loc = detectLocation(a.address);
            return { label: 'Siteden', city: loc.city, district: loc.district, address: a.address, sourceUrl: a.sourceUrl };
          }),
        );
      }
      pages.forEach((p) => p.emails.forEach((email) => contacts.push({ email, sourceUrl: p.url })));
      await this.registerDiscoveredSources(company, pages.flatMap((p) => p.links));
    }
    if (contacts.length) {
      const fakeSource = { companyId: company.id } as any;
      await this.ingest.saveContacts(fakeSource, contacts);
    }
    const profile = await this.prisma.searchProfile.findFirst({ where: { workspaceId: company.workspaceId, active: true }, orderBy: { createdAt: 'asc' } });
    const [knownHr, knownOfficeCount] = await Promise.all([
      this.prisma.contactPoint.count({ where: { companyId: company.id, suppressed: false, kind: { in: ['official_hr', 'job_apply'] } } }),
      this.prisma.office.count({ where: { companyId: company.id, locationConfidence: { in: ['medium', 'high'] } } }),
    ]);
    const result = await this.ai.run({
      workspaceId: company.workspaceId,
      kind: 'company_report',
      input: {
        company: { name: company.name, domain: company.canonicalDomain, sectors: company.sectors },
        targetRole: profile?.exactTitles?.[0] ?? null,
        sectors: profile?.sectors ?? [],
        regions: [...new Set([profile?.city, ...(profile?.districtsPrimary ?? [])].filter(Boolean))].slice(0, 40),
        known: { hrEmail: knownHr > 0, office: knownOfficeCount > 0 },
        sources,
      },
      validation: { sourceIds: sources.map((s) => s.id) },
      entityType: 'Company',
      entityId: company.id,
      createdById: actorId,
      useCache: !actorId,
      context: { companyId: company.id, sources: sources.map((s) => ({ id: s.id, url: s.url })) },
    });
    await this.prisma.company.update({ where: { id: company.id }, data: { lastResearchedAt: new Date() } });
    if (result.status === 'succeeded') {
      await this.applyReport(company.id, result.output, sources, result.taskId, result.provider);
      const details = await this.findContactsIfMissing(company, actorId);
      const at = new Date().toISOString();
      await this.recordSearch(company.id, details.status === 'exists' ? { reportAt: at } : { reportAt: at, contactsSearchedAt: at, officesSearchedAt: at });
      return { status: 'succeeded', provider: result.provider, taskId: result.taskId };
    }
    await this.prisma.company.update({ where: { id: company.id }, data: { researchReport: { status: 'awaiting_user', taskId: result.taskId, at: new Date().toISOString() } } });
    return { status: 'awaiting_user', taskId: result.taskId };
  }

  private async crawlSite(company: Company, base: string, opts: { detectOffice?: boolean } = {}) {
    const out: { url: string; text: string; emails: string[]; links: string[]; addresses: string[] }[] = [];
    const visited = new Set<string>();
    const queue = [base];
    const host = (() => {
      try {
        return new URL(base).hostname.replace(/^www\./, '');
      } catch {
        return null;
      }
    })();
    if (host) queue.push(`https://kariyer.${host}/`, `https://careers.${host}/`);
    const baseHost = (() => {
      try {
        return new URL(base).hostname.replace(/^www\./, '');
      } catch {
        return null;
      }
    })();
    if (!baseHost) return out;
    while (queue.length && out.length < 6) {
      const url = queue.shift()!;
      if (visited.has(url)) continue;
      visited.add(url);
      try {
        if (!(await robotsAllows(url))) continue;
      } catch {
        continue;
      }
      const r = await fetchSource(url);
      if (r.state !== 'ok' || !r.res || !/html/.test(r.res.headers['content-type'] ?? 'text/html')) continue;
      const html = r.res.text();
      const $ = cheerio.load(html);
      const links: string[] = [];
      $('a[href]').each((_, el) => {
        const href = $(el).attr('href');
        if (!href) return;
        try {
          const abs = new URL(href, url).toString().split('#')[0];
          links.push(abs);
          const h = new URL(abs).hostname.replace(/^www\./, '');
          if (h === baseHost && INTERESTING.test(abs) && !visited.has(abs) && queue.length < 12) queue.push(abs);
        } catch {
          /* geçersiz link */
        }
      });
      const emails = new Set<string>();
      $('a[href^="mailto:"]').each((_, el) => {
        const m = ($(el).attr('href') ?? '').replace(/^mailto:/i, '').split('?')[0].trim().toLowerCase();
        if (m) emails.add(m);
      });
      for (const m of stripHtml(html).matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi)) emails.add(m[0].toLowerCase());
      // İzinli kısa kanıt parçası; ham sayfa saklanmaz.
      const pageText = stripHtml($('main').html() ?? $('body').html() ?? html);
      out.push({ url, text: truncate(pageText, 3500) ?? '', emails: [...emails], links, addresses: extractAddresses(html, stripHtml(html)) });
      if (out.length === 1 && opts.detectOffice !== false) {
        const loc = detectLocation(stripHtml(html));
        const hasOffice = await this.prisma.office.count({ where: { companyId: company.id } });
        if (!hasOffice && loc.district) {
          await this.prisma.office.create({ data: { companyId: company.id, kind: 'hq', district: loc.district, city: loc.city, label: 'Siteden tespit edilen adres', locationConfidence: 'low' } });
        }
      }
    }
    return out;
  }

  /** Kariyer sayfası ve kamuya açık başvuru panoları (Greenhouse, Lever, Workable, Teamtailor…) otomatik kaynak olarak eklenir. */
  async registerDiscoveredSources(company: Company, links: string[], opts: { explicitCareersUrl?: string | null } = {}) {
    const existing = await this.prisma.sourceConnector.findMany({ where: { companyId: company.id } });
    const sameConfig = (a: unknown, b: Record<string, string>) => Object.entries(b).every(([key, value]) => (a as Record<string, unknown> | null)?.[key] === value);
    for (const link of links) {
      const ats = detectAtsSource(link);
      if (ats) {
        if (!existing.some((s) => s.kind === ats.kind && sameConfig(s.config, ats.config))) {
          existing.push(await this.prisma.sourceConnector.create({ data: { workspaceId: company.workspaceId, companyId: company.id, ...discoveredSourceData(ats.kind, company.name, ats.config), nextRunAt: new Date() } }));
        }
        continue;
      }
      try {
        const u = new URL(link);
        const sameDomain = company.canonicalDomain && u.hostname.replace(/^www\./, '').endsWith(company.canonicalDomain);
        const isCareers = CAREERS.test(u.pathname) || link === opts.explicitCareersUrl;
        const careerPages = existing.filter((s) => s.kind === 'career_page');
        const upgradesToTurkish = isTurkishUrl(link) && !careerPages.some((s) => isTurkishUrl((s.config as { url?: string })?.url));
        if (sameDomain && isCareers && (careerPages.length === 0 || upgradesToTurkish)) {
          existing.push(await this.prisma.sourceConnector.create({ data: { workspaceId: company.workspaceId, companyId: company.id, ...discoveredSourceData('career_page', company.name, { url: link }), nextRunAt: new Date() } }));
          await this.prisma.company.update({ where: { id: company.id }, data: { careersUrl: link } });
        }
      } catch {
        /* yoksay */
      }
    }
  }

  /** AI raporunu uygular: kanıtlar (kaynaklı), hizmetler, rapor; ardından Q yeniden hesaplanır. */
  async findContactsIfMissing(company: Company, actorId: string | null) {
    const hasHr = await this.prisma.contactPoint.count({ where: { companyId: company.id, suppressed: false, kind: { in: ['official_hr', 'job_apply'] } } });
    if (hasHr) return { status: 'exists' as const };
    return this.findDetails(company.id, actorId, { skipCrawl: true });
  }

  /**
   * Önce ortak kataloğa bakılır: başka bir çalışma alanında bulunmuş, bu firmada henüz olmayan gönderilebilir adres
   * varsa yapay zekâ çağrısı yapılmaz. Arama hafızalıdır (domain/contact-search): aynı derinlikte yakın zamanda yapılmış
   * arama tekrarlanmaz. Hat: firma sitesi taranır (yapay zekâsız) → toplayıcı model (Sonnet) web'de aday adresleri toplar
   * → her adayın kaynak sayfası okunup adres orada geçiyor mu bakılır → derin aramada denetçi model (Opus) kesin olmayan
   * adayları değerlendirir. Tür, rol ve güven skoru domain/contact-research kurallarıyla belirlenir; ölü, geri dönmüş ve
   * kullanıcının istemediği adresler hiç eklenmez.
   */
  async findDetails(companyId: string, actorId: string | null, opts: DetailsOptions = {}) {
    let company = await this.prisma.company.findUnique({ where: { id: companyId } });
    if (!company) return { status: 'missing' as const };
    const deep = opts.deep === true;
    const searchFeatures = { deep, forced: !!opts.force, hasDomain: !!company.canonicalDomain, employeeRange: company.employeeRange };
    const sendableBefore = await this.sendableCount(company.id);
    const shared = await this.catalog.sync(company.id);
    const sendableFromCatalog = shared.contacts ? (await this.sendableCount(company.id)) - sendableBefore : 0;
    if (sendableFromCatalog > 0) {
      await this.recordSearch(company.id, {});
      await this.learning.record({ workspaceId: company.workspaceId, kind: 'contact_search', companyId: company.id, features: { ...searchFeatures, source: 'catalog' }, outcome: { added: sendableFromCatalog } });
      return { status: 'succeeded' as const, source: 'catalog' as const };
    }
    const plan = contactSearchPlan(company.researchMeta as ResearchMeta, { deep, force: opts.force, since: opts.since });
    if (plan.skip) return { status: 'skipped' as const, reason: plan.skip };
    const manualBefore = await this.manualCount(company.id);
    const avoidEmails = [...new Set([...(opts.avoidEmails ?? []), ...(await this.addressBook.avoidedForCompany(company.id))].map((e) => e.toLowerCase()))];
    const avoid = new Set(avoidEmails);
    const stored = await this.prisma.contactPoint.findMany({ where: { companyId: company.id }, orderBy: { discoveredAt: 'desc' }, select: { email: true, kind: true, suppressed: true, sourceUrl: true } });
    const profile = await this.prisma.searchProfile.findFirst({ where: { workspaceId: company.workspaceId, active: true }, orderBy: { createdAt: 'asc' } });
    const hints = await this.models.contactSearchHints();
    const base = company.website ?? (company.canonicalDomain ? `https://${company.canonicalDomain}` : null);
    const sitePages = base && !opts.skipCrawl ? await this.crawlSite(company, base, { detectOffice: false }) : [];
    const knownEmails = stored.filter((c) => !c.suppressed && [...SENDABLE_CONTACT_KINDS, ...MANUAL_ONLY_KINDS].includes(c.kind)).map((c) => c.email);
    const harvest = await this.ai.run({
      workspaceId: company.workspaceId,
      kind: 'company_contacts',
      input: {
        company: { name: company.name, domain: company.canonicalDomain },
        regions: [...new Set([profile?.city, ...(profile?.districtsPrimary ?? [])].filter(Boolean))].slice(0, 40),
        ...(knownEmails.length ? { knownEmails: knownEmails.slice(0, MAX_KNOWN_IN_PROMPT) } : {}),
        ...(avoidEmails.length ? { avoidEmails } : {}),
        ...(hints.length ? { hints } : {}),
      },
      entityType: 'Company',
      entityId: company.id,
      createdById: actorId,
      allowManual: false,
      allowTemplate: false,
      useCache: false,
    });
    if (harvest.status !== 'succeeded') return { status: harvest.status };
    const found = harvest.output as HarvestOutput;
    const adopted = await this.adoptWebsite(company, found);
    const adoptedPages = adopted.canonicalDomain !== company.canonicalDomain && !opts.skipCrawl ? await this.crawlSite(adopted, adopted.website ?? `https://${adopted.canonicalDomain}`, { detectOffice: false }) : [];
    company = adopted;
    const ownDomain = (email: string) => domainMatches(email, adopted.canonicalDomain, adopted.aliases);
    const restored = new Set(stored.filter((c) => !c.suppressed && c.kind === CANDIDATE_HR_KIND && ownDomain(c.email)).map((c) => c.email));
    const known = new Set(stored.filter((c) => c.suppressed || (!REVIEWABLE_STORED_KINDS.includes(c.kind) && !restored.has(c.email))).map((c) => c.email));
    const merged = mergeCandidates([
      ...[...sitePages, ...adoptedPages].flatMap((p) => p.emails.map((email): ResearchCandidate => ({ email, sourceUrl: p.url, origin: 'site' }))),
      ...found.contacts.map(
        (c): ResearchCandidate => ({ email: c.email, sourceUrl: c.sourceUrl ?? null, origin: c.origin === 'pattern' || c.origin === 'likely' ? 'pattern' : 'published', name: c.name, title: c.title, roleType: c.roleType ?? c.purpose, evidence: c.evidence }),
      ),
      ...stored.filter((c) => restored.has(c.email)).map((c): ResearchCandidate => ({ email: c.email, sourceUrl: c.sourceUrl, origin: 'stored' })),
      ...(deep ? stored.filter((c) => !c.suppressed && REVIEWABLE_STORED_KINDS.includes(c.kind)).slice(0, MAX_STORED_FOR_REVIEW).map((c): ResearchCandidate => ({ email: c.email, sourceUrl: c.sourceUrl, origin: 'stored' })) : []),
    ]).filter((c) => isValidEmail(c.email) && !avoid.has(c.email) && !known.has(c.email) && !isOffTopicAddress(c.email));
    const dead = await this.addressBook.deadAmong(merged.map((c) => c.email));
    const candidates = merged.filter((c) => !dead.has(c.email)).slice(0, MAX_CANDIDATES);
    const checks = await this.checkSources(candidates);
    const providers: string[] = [harvest.provider];
    const toReview = deep ? candidates.filter((c) => needsReview(c, checks.get(c.email)!, ownDomain(c.email))).slice(0, MAX_REVIEWED) : [];
    const reviews = toReview.length ? await this.reviewCandidates(company, found.group?.name ?? null, toReview, checks, actorId) : null;
    if (reviews) providers.push(`${reviews.provider}:review`);
    const reviewed = new Set(reviews ? toReview.map((c) => c.email) : []);
    const ruled = candidates
      .map((c) => settleCandidate(c, { check: checks.get(c.email)!, domainMatch: ownDomain(c.email), reviewed: reviewed.has(c.email), review: reviews?.byEmail.get(c.email) }))
      .filter((c): c is SettledContact => c !== null);
    const nothingSendable = sendableBefore === 0 && !ruled.some((c) => SENDABLE_CONTACT_KINDS.includes(c.kind));
    const probe = deep ? await this.probeGuesses(company, ruled, { searchGeneric: nothingSendable, exclude: new Set([...stored.map((c) => c.email), ...avoid, ...merged.map((c) => c.email)]) }) : { contacts: ruled, probed: 0 };
    if (probe.probed) providers.push('smtp');
    const settled = probe.contacts;
    if (settled.length) {
      await this.ingest.saveContacts(
        { companyId: company.id } as SourceConnector,
        settled.map((c) => ({ email: c.email, sourceUrl: c.sourceUrl, kind: c.kind, verified: c.verified, name: c.name, title: c.title, roleType: c.roleType, score: c.score, evidence: c.evidence })),
        providers.join('+'),
      );
    }
    await this.applyGroup(company, found.group ?? null);
    await this.applySize(company.id, found.employees);
    const knownOffices = await this.prisma.office.count({ where: { companyId: company.id, locationConfidence: { in: ['medium', 'high'] } } });
    if (!knownOffices) await this.applyOffices(company.id, found.offices);
    await this.prisma.company.update({ where: { id: company.id }, data: { lastResearchedAt: new Date() } });
    const reached: SearchDepth = deep && (reviews || !toReview.length) ? 'max' : 'base';
    const at = new Date().toISOString();
    await this.recordSearch(company.id, { contactsSearchedAt: at, officesSearchedAt: at, contactsDepth: reached, ...(reached === 'max' ? { contactsVersion: SEARCH_VERSION } : {}) });
    await this.catalog.publish(company.id);
    await this.learning.record({
      workspaceId: company.workspaceId,
      kind: 'contact_search',
      companyId: company.id,
      aiTaskId: harvest.taskId,
      features: { ...searchFeatures, source: 'ai', providers, depth: reached, avoided: avoidEmails.length, hints: hints.length > 0, candidates: candidates.length, reviewed: reviewed.size, adoptedDomain: !searchFeatures.hasDomain && !!company.canonicalDomain, probed: probe.probed },
      outcome: {
        returned: found.contacts.length,
        reliable: settled.some((c) => RECRUITING_KINDS.includes(c.kind) && c.score >= RELIABLE_SCORE),
        added: (await this.sendableCount(company.id)) - sendableBefore,
        manual: (await this.manualCount(company.id)) - manualBefore,
        group: !!found.group?.hrEmail,
      },
    });
    return { status: 'succeeded' as const, source: 'ai' as const };
  }

  /**
   * Alan adı bilinmeyen firmada modelin bulduğu resmî site benimsenir: alan adı firmanın adını taşımalı ya da modelin
   * bulduğu adres/ofis kaynaklarından biri o alan adında olmalı, ayrıca alan adı çözülmeli. Böylece site taranır ve
   * bulunan adresler firmanın kendi adresi sayılır. Aynı alan adı çalışma alanında başka firmadaysa benimsenmez.
   */
  private async adoptWebsite(company: Company, found: HarvestOutput): Promise<Company> {
    if (company.canonicalDomain) return company;
    const url = this.safeHttpUrl(found.website);
    const domain = url ? websiteDomainFor(company.name, url, [...found.contacts.map((c) => c.sourceUrl), ...found.offices.map((o) => o.sourceUrl)]) : null;
    if (!url || !domain) return company;
    const resolves = await dns.lookup(new URL(url).hostname).then(
      () => true,
      () => false,
    );
    if (!resolves) return company;
    const taken = await this.prisma.company.findFirst({ where: { workspaceId: company.workspaceId, canonicalDomain: domain }, select: { id: true } });
    if (taken) return company;
    try {
      return await this.prisma.company.update({ where: { id: company.id }, data: { canonicalDomain: domain, website: company.website ?? url } });
    } catch {
      return company;
    }
  }

  /**
   * Tahmini adresler alan adının posta sunucusuna sorulur (mail gönderilmez). Hiç gönderilebilir adres yoksa firmanın
   * alan adındaki yaygın başvuru adresleri (kariyer@, ik@, info@…) de denenir. Olmayan kutu düşer, var olduğu doğrulanan
   * kutu rolünün türüne yükselir; sunucu bir şey söylemezse en olası iki adres tahmini olarak listelenir.
   */
  private async probeGuesses(company: Company, settled: SettledContact[], opts: { searchGeneric: boolean; exclude: Set<string> }) {
    const domain = company.canonicalDomain;
    if (!env().CONTACT_SMTP_PROBE || !domain) return { contacts: settled, probed: 0 };
    const onDomain = (email: string) => email.split('@')[1] === domain;
    const guesses = settled.filter((c) => c.kind === 'guessed' && onDomain(c.email));
    const candidates = opts.searchGeneric ? roleGuessesFor(domain).filter((e) => !opts.exclude.has(e) && !settled.some((c) => c.email === e)) : [];
    const dead = await this.addressBook.deadAmong(candidates);
    const generic = candidates.filter((e) => !dead.has(e));
    const targets = [...guesses.map((c) => c.email), ...generic];
    if (!targets.length) return { contacts: settled, probed: 0 };
    const probe = await probeMailboxes(domain, targets, { helo: probeHelo() });
    if (!probe.mx) return { contacts: settled.filter((c) => !guesses.includes(c)), probed: targets.length };
    const verdictOf = (email: string) => probe.verdicts.get(email) ?? 'unknown';
    const ruled = settled.map((c) => (guesses.includes(c) ? settleProbedGuess(c, verdictOf(c.email), probe.catchAll) : c)).filter((c): c is SettledContact => c !== null);
    const probedGeneric = generic.map((e) => settleProbedGuess(genericGuess(e), verdictOf(e), probe.catchAll)).filter((c): c is SettledContact => c !== null);
    const confirmedElsewhere = ruled.some((c) => SENDABLE_CONTACT_KINDS.includes(c.kind));
    return { contacts: [...ruled, ...pickGenericGuesses(probedGeneric, confirmedElsewhere)], probed: targets.length };
  }

  /** Her adayın kaynak sayfası düz HTTP ile (robots'a uyarak) okunur; CAPTCHA ya da bot korumalı sayfa aşılmaz, "okunamadı" sayılır. */
  private async checkSources(candidates: ResearchCandidate[]) {
    const pages = new Map<string, string | null>();
    const checks = new Map<string, SourceCheck>();
    for (const c of candidates) {
      if (c.origin === 'site') {
        checks.set(c.email, 'found');
        continue;
      }
      if (!sourceIsReadable(c.sourceUrl) || (!pages.has(c.sourceUrl!) && pages.size >= MAX_SOURCE_PAGES)) {
        checks.set(c.email, 'unreadable');
        continue;
      }
      const page = await this.sourcePage(c.sourceUrl!, pages);
      checks.set(c.email, page === null ? 'unreadable' : pageMentionsEmail(page, c.email) ? 'found' : 'missing');
    }
    return checks;
  }

  /** Denetçi model kesin olmayan adayları değerlendirir; başarısız olursa adaylar denetlenmemiş kurallarla kaydedilir. */
  private async reviewCandidates(company: Company, groupName: string | null, candidates: ResearchCandidate[], checks: Map<string, SourceCheck>, actorId: string | null) {
    const refs = candidates.map((c, i) => ({ ref: `A${i + 1}`, c }));
    const r = await this.ai.run({
      workspaceId: company.workspaceId,
      kind: 'contact_review',
      input: {
        company: { name: company.name, domain: company.canonicalDomain, groupName: company.groupName ?? groupName },
        candidates: refs.map(({ ref, c }) => ({
          ref,
          email: c.email,
          name: c.name ?? null,
          title: c.title ?? null,
          roleType: c.roleType ?? null,
          origin: c.origin,
          sourceUrl: c.sourceUrl,
          evidence: c.evidence ?? null,
          sourceCheck: checks.get(c.email),
          domainMatch: domainMatches(c.email, company.canonicalDomain, company.aliases),
        })),
      },
      entityType: 'Company',
      entityId: company.id,
      createdById: actorId,
      allowManual: false,
      allowTemplate: false,
      useCache: false,
    });
    if (r.status !== 'succeeded') return null;
    const byRef = new Map(refs.map(({ ref, c }) => [ref, c.email]));
    const byEmail = new Map<string, CandidateReview>();
    for (const review of (r.output as { reviews: (CandidateReview & { ref: string })[] }).reviews ?? []) {
      const email = byRef.get(review.ref);
      if (email) byEmail.set(email, review);
    }
    return { provider: r.provider, byEmail };
  }

  /**
   * Kaynağında doğrulanmış adreslerin yapay zekâsız yeniden teyidi: ulaştığı bilinen adres doğrulanmış kalır, diğerlerinde
   * adresin yayımlandığı sayfa yeniden okunur. Sayfada artık yer almayan adresin doğrulaması düşer; okunamayan sayfa
   * bir hafta sonra yeniden denenir. Dönen firmalar, doğrulanmış adresi kalmayan ve henüz başvurulmamış olanlardır.
   */
  async reverifyContacts(workspaceId: string, now = new Date(), limit = REVERIFY_BATCH) {
    const due = await this.prisma.contactPoint.findMany({
      where: { workspaceId, verifiedBy: 'source', suppressed: false, verifiedAt: { lt: new Date(now.getTime() - REVERIFY_AFTER_DAYS * DAY_MS) } },
      orderBy: { verifiedAt: 'asc' },
      take: limit,
      select: { id: true, email: true, sourceUrl: true, companyId: true },
    });
    const stats = { checked: due.length, confirmed: 0, lapsed: 0, postponed: 0, companyIds: [] as string[] };
    if (!due.length) return stats;
    const reached = new Set((await this.prisma.addressRecord.findMany({ where: { email: { in: due.map((c) => c.email) }, status: 'deliverable' }, select: { email: true } })).map((r) => r.email));
    const pages = new Map<string, string | null>();
    const lapsedCompanies = new Set<string>();
    for (const contact of due) {
      if (reached.has(contact.email)) {
        await this.prisma.contactPoint.update({ where: { id: contact.id }, data: { verifiedAt: now, verifiedBy: 'delivery' } });
        stats.confirmed++;
        continue;
      }
      const page = contact.sourceUrl ? await this.sourcePage(contact.sourceUrl, pages) : null;
      if (page === null) {
        await this.prisma.contactPoint.update({ where: { id: contact.id }, data: { verifiedAt: new Date(now.getTime() - (REVERIFY_AFTER_DAYS - REVERIFY_RETRY_DAYS) * DAY_MS) } });
        stats.postponed++;
      } else if (page.includes(contact.email.toLowerCase())) {
        await this.prisma.contactPoint.update({ where: { id: contact.id }, data: { verifiedAt: now } });
        stats.confirmed++;
      } else {
        await this.prisma.contactPoint.update({ where: { id: contact.id }, data: { verifiedAt: null } });
        lapsedCompanies.add(contact.companyId);
        stats.lapsed++;
      }
    }
    for (const companyId of lapsedCompanies) {
      const [verified, applied] = await Promise.all([
        this.prisma.contactPoint.count({ where: { companyId, suppressed: false, verifiedAt: { not: null }, kind: { in: SENDABLE_CONTACT_KINDS } } }),
        this.prisma.applicationAttempt.count({ where: { companyId, state: { in: APPLIED_STATES } } }),
      ]);
      if (!verified && !applied) stats.companyIds.push(companyId);
    }
    return stats;
  }

  /** Sayfanın küçük harfe çevrilmiş içeriği; okunamıyorsa (erişim yok, robots izin vermiyor, HTML değil) null. */
  private async sourcePage(url: string, cache: Map<string, string | null>): Promise<string | null> {
    if (cache.has(url)) return cache.get(url) ?? null;
    let page: string | null = null;
    try {
      if (await robotsAllows(url)) {
        const r = await fetchSource(url);
        if (r.state === 'ok' && r.res && READABLE_PAGE.test(r.res.headers['content-type'] ?? 'text/html')) page = r.res.text().toLowerCase();
      }
    } catch {
      page = null;
    }
    cache.set(url, page);
    return page;
  }

  private sendableCount(companyId: string) {
    return this.prisma.contactPoint.count({ where: { companyId, suppressed: false, kind: { in: SENDABLE_CONTACT_KINDS } } });
  }

  private manualCount(companyId: string) {
    return this.prisma.contactPoint.count({ where: { companyId, suppressed: false, kind: { in: MANUAL_ONLY_KINDS } } });
  }

  /** Toplu tekrar aramada önceki tur adres bulduysa ikinci tur atlanır. */
  async hasSendableContact(companyId: string) {
    return (await this.sendableCount(companyId)) > 0;
  }

  /** Kaynaktaki çalışan sayısı metnini firmaya işler. Bilinen değer yalnızca özel aramada (overwrite) güncellenir. */
  private async applySize(companyId: string, employees: string | null | undefined, opts: { overwrite?: boolean; linkedinUrl?: string | null } = {}) {
    const size = parseEmployees(employees);
    const linkedinUrl = opts.linkedinUrl && LINKEDIN_COMPANY_URL.test(opts.linkedinUrl) ? opts.linkedinUrl : null;
    if (!size && !linkedinUrl) return false;
    const company = await this.prisma.company.findUnique({ where: { id: companyId }, select: { employeeRange: true, linkedinUrl: true } });
    if (!company) return false;
    const takeSize = !!size && (opts.overwrite || !company.employeeRange);
    const data = { ...(takeSize ? { employeeRange: size.range, employeeCount: size.count } : {}), ...(linkedinUrl && !company.linkedinUrl ? { linkedinUrl } : {}) };
    if (Object.keys(data).length) await this.prisma.company.update({ where: { id: companyId }, data });
    return takeSize;
  }

  /** Çalışan sayısı bilinmeyen ve yakın zamanda aranmamış firmalar; izlenen ve puanı yüksek olanlar önce. */
  async sizeCandidates(workspaceId: string, limit: number, now = Date.now()) {
    const companies = await this.prisma.company.findMany({
      where: { workspaceId, excluded: false, employeeRange: null },
      select: { id: true, researchMeta: true },
      orderBy: [{ watch: 'desc' }, { qScore: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
    });
    const due = (meta: unknown) => {
      const at = (meta as ResearchMeta | null)?.sizeSearchedAt;
      return !at || now - new Date(at).getTime() > SIZE_RETRY_DAYS * DAY_MS;
    };
    return companies.filter((c) => due(c.researchMeta)).slice(0, limit).map((c) => c.id);
  }

  /**
   * Bir grup firmanın çalışan sayısını tek çağrıda araştırır. Ortak katalogda bilinenler oradan alınır; yalnızca
   * kalanlar yapay zekâya sorulur ve bulunan değer kataloğa da yazılır.
   */
  async findSizes(workspaceId: string, companyIds: string[], actorId: string | null = null) {
    const companies = await this.prisma.company.findMany({ where: { id: { in: companyIds }, workspaceId, employeeRange: null }, select: { id: true, name: true, canonicalDomain: true } });
    const unknown: typeof companies = [];
    for (const c of companies) if (!(await this.catalog.pull(c.id)).size) unknown.push(c);
    if (!unknown.length) return { status: 'succeeded' as const, asked: 0, found: 0, fromCatalog: companies.length };
    const asked = unknown.slice(0, SIZE_BATCH).map((company, i) => ({ ref: `C${i + 1}`, company }));
    const r = await this.ai.run({
      workspaceId,
      kind: 'company_sizes',
      input: { companies: asked.map(({ ref, company }) => ({ ref, name: company.name, domain: company.canonicalDomain })) },
      createdById: actorId,
      allowManual: false,
      allowTemplate: false,
      useCache: false,
    });
    if (r.status !== 'succeeded') return { status: r.status, asked: asked.length, found: 0, fromCatalog: companies.length - unknown.length };
    const answers = new Map(((r.output as { sizes: SizeAnswer[] }).sizes ?? []).map((s) => [s.ref, s]));
    const at = new Date().toISOString();
    let found = 0;
    for (const { ref, company } of asked) {
      const answer = answers.get(ref);
      const applied = await this.applySize(company.id, answer?.employees, { overwrite: true, linkedinUrl: answer?.linkedinUrl });
      await this.recordSearch(company.id, { sizeSearchedAt: at });
      if (!applied) continue;
      found++;
      await this.catalog.publish(company.id);
    }
    await this.learning.record({ workspaceId, kind: 'size_search', aiTaskId: r.taskId, features: { provider: r.provider, asked: asked.length }, outcome: { found } });
    return { status: 'succeeded' as const, asked: asked.length, found, fromCatalog: companies.length - unknown.length };
  }

  async isPaused(workspaceId: string | null | undefined) {
    if (!workspaceId) return false;
    return !!(await this.prisma.keyValue.findUnique({ where: { key: `${SEARCH_PAUSE_PREFIX}${workspaceId}` } }));
  }

  async setPaused(workspaceId: string, paused: boolean) {
    const key = `${SEARCH_PAUSE_PREFIX}${workspaceId}`;
    if (paused) await this.prisma.keyValue.upsert({ where: { key }, create: { key, value: { at: new Date().toISOString() } }, update: { value: { at: new Date().toISOString() } } });
    else await this.prisma.keyValue.deleteMany({ where: { key } });
  }

  async segmentLog(searchProfileId: string): Promise<SegmentLog> {
    const kv = await this.prisma.keyValue.findUnique({ where: { key: `${DISCOVERY_LOG_PREFIX}${searchProfileId}` } });
    return (kv?.value ?? {}) as SegmentLog;
  }

  private async logSegment(searchProfileId: string, segment: string, created: number) {
    const log = { ...(await this.segmentLog(searchProfileId)), [segment]: { at: new Date().toISOString(), created } };
    const key = `${DISCOVERY_LOG_PREFIX}${searchProfileId}`;
    await this.prisma.keyValue.upsert({ where: { key }, create: { key, value: log }, update: { value: log } });
  }

  async recordSearch(companyId: string, patch: ResearchMeta) {
    const [company, hrContacts, knownOffices] = await Promise.all([
      this.prisma.company.findUnique({ where: { id: companyId }, select: { researchMeta: true } }),
      this.prisma.contactPoint.count({ where: { companyId, suppressed: false, kind: { in: ['official_hr', 'job_apply'] } } }),
      this.prisma.office.count({ where: { companyId, locationConfidence: { in: ['medium', 'high'] } } }),
    ]);
    if (!company) return;
    const meta: ResearchMeta = { ...((company.researchMeta ?? {}) as ResearchMeta), ...patch, contactsFound: hrContacts > 0, officesFound: knownOffices > 0 };
    await this.prisma.company.update({ where: { id: companyId }, data: { researchMeta: meta as Prisma.InputJsonValue } });
  }

  private async applyGroup(company: { id: string; workspaceId: string; groupName: string | null; canonicalDomain: string | null }, group: GroupInfo | null) {
    if (!group?.name) return;
    if (!company.groupName) await this.prisma.company.update({ where: { id: company.id }, data: { groupName: group.name } });
    const email = group.hrEmail ? cleanEmail(group.hrEmail) : null;
    if (!email || !isValidEmail(email) || !/^https?:\/\//.test(group.sourceUrl ?? '')) return;
    if (domainMatches(email, company.canonicalDomain) || (await this.addressBook.isDead(email))) return;
    const data = { kind: GROUP_HR_KIND, purpose: 'hr', sourceUrl: group.sourceUrl, ownershipEvidence: `Grup: ${group.name}`, confidence: 'medium' };
    await this.prisma.contactPoint.upsert({
      where: { companyId_email: { companyId: company.id, email } },
      create: { workspaceId: company.workspaceId, companyId: company.id, email, ...data },
      update: {},
    });
  }

  /** Bulunan tüm yayımlanmış adresler saklanır; tür yerel kısma göre belirlenir, gönderilemeyen türler yalnızca kayıt içindir. */
  private async applyContacts(companyId: string, contacts: { email: string; sourceUrl: string; purpose?: string | null }[], foundBy = 'ai') {
    const company = await this.prisma.company.findUnique({ where: { id: companyId }, select: { canonicalDomain: true, aliases: true } });
    const published = contacts
      .map((c) => ({ email: cleanEmail(c.email), sourceUrl: c.sourceUrl, kind: foundContactKind(c, company) }))
      .filter((c) => isValidEmail(c.email) && /^https?:\/\//.test(c.sourceUrl));
    if (published.length) await this.ingest.saveContacts({ companyId } as SourceConnector, published, foundBy);
  }

  private async applyOffices(companyId: string, offices: { label?: string | null; city?: string | null; district?: string | null; address?: string | null; sourceUrl?: string | null }[]) {
    const usable = offices.filter((o) => o.city || o.district || o.address);
    if (!usable.length) return;
    await this.prisma.office.deleteMany({ where: { companyId, locationConfidence: { in: ['low', 'medium'] } } });
    for (const o of usable) {
      const detected = detectLocation([o.district, o.address, o.city].filter(Boolean).join(' '));
      await this.prisma.office.create({
        data: {
          companyId,
          kind: /merkez|hq|headquarter/i.test(o.label ?? '') ? 'hq' : 'office',
          label: o.label ?? 'Ofis',
          city: o.city ?? detected.city,
          district: o.district ?? detected.district,
          address: [o.address, o.sourceUrl ? `(kaynak: ${o.sourceUrl})` : null].filter(Boolean).join(' ') || null,
          locationConfidence: 'medium',
        },
      });
    }
  }

  async applyReport(companyId: string, output: any, sources: { id: string; url: string }[], taskId: string, provider: string) {
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: companyId } });
    const urlFor = (ref: string, url?: string | null) => url ?? sources.find((s) => s.id === ref)?.url ?? null;
    await this.prisma.companyEvidence.deleteMany({ where: { companyId, createdBy: 'ai', accepted: true, aiTaskId: { not: taskId } } });
    await this.applyOffices(companyId, output.offices ?? []);
    await this.applyContacts(companyId, output.contacts ?? [], provider);
    await this.applySize(companyId, output.employees);
    for (const e of output.evidence ?? []) {
      const d = e.evidenceDate ? new Date(e.evidenceDate.length === 7 ? `${e.evidenceDate}-01` : e.evidenceDate) : null;
      await this.prisma.companyEvidence.create({
        data: {
          workspaceId: company.workspaceId,
          companyId,
          dimension: e.dimension,
          customerName: e.customerName ?? null,
          scope: e.scope,
          claimType: e.claimType,
          title: e.title,
          summary: e.summary ?? null,
          url: urlFor(e.sourceRef, e.url),
          evidenceDate: d && !isNaN(d.getTime()) ? d : null,
          // AI çıkarımı en fazla "orta" güvenle kaydedilir; kullanıcı doğrulayarak yükseltebilir.
          confidence: e.confidence === 'high' ? 'medium' : e.confidence,
          createdBy: 'ai',
          aiTaskId: taskId,
        },
      });
    }
    const services = [...new Set([...(company.services ?? []), ...((output.services ?? []) as string[])])].slice(0, 30);
    await this.prisma.company.update({
      where: { id: companyId },
      data: {
        services,
        researchReport: {
          status: 'done',
          provider,
          taskId,
          at: new Date().toISOString(),
          summary: output.summary,
          roleNeedInference: output.roleNeedInference ?? null,
          applicationAngle: output.applicationAngle ?? null,
          confirmQuestions: output.confirmQuestions ?? [],
          sources,
        } as Prisma.InputJsonValue,
      },
    });
    await this.scoring.recompute(companyId);
    await this.outbox.emit({ workspaceId: company.workspaceId, eventType: 'evaluate.company', aggregateId: companyId, dedupKey: `eval-company:${companyId}:research:${taskId}`, payload: { companyId } });
  }

  /** Manuel köprüden gelen cevabı ilgili akışa uygular. */
  async applyCompletedTask(taskId: string) {
    const task = await this.prisma.aiTask.findUnique({ where: { id: taskId } });
    if (!task || task.status !== 'succeeded') return;
    const ctx = (task.context ?? {}) as any;
    if (task.kind === 'company_report' && ctx.companyId) {
      await this.applyReport(ctx.companyId, task.output, ctx.sources ?? [], task.id, task.provider);
    }
    if (task.kind === 'company_discovery') {
      const profile = ctx.searchProfileId ? await this.prisma.searchProfile.findUnique({ where: { id: ctx.searchProfileId }, select: { exactTitles: true, adjacentTitles: true } }) : null;
      await this.applyDiscovery(task.workspaceId, task.output as any, task.id, { titles: profile ? [...profile.exactTitles, ...profile.adjacentTitles] : [] });
    }
  }

  /**
   * Unvan odaklı keşif: arama profilindeki hedef/yakın unvanlar, bölge ve sektörlere göre yeni firma adayları
   * (CLI web araştırması veya manuel köprü). Profil verilmezse tüm aktif profiller için çalışır.
   */
  async expandTitles(searchProfileId: string, actorId: string | null) {
    const profile = await this.prisma.searchProfile.findUnique({ where: { id: searchProfileId }, include: { candidate: { select: { headline: true } } } });
    if (!profile?.exactTitles.length) return { added: 0 };
    const r = await this.ai.run({
      workspaceId: profile.workspaceId,
      kind: 'title_expansion',
      input: { exactTitles: profile.exactTitles, headline: profile.candidate.headline },
      createdById: actorId,
      allowManual: false,
      allowTemplate: false,
      entityType: 'SearchProfile',
      entityId: profile.id,
    });
    if (r.status !== 'succeeded') return { added: 0 };
    const taken = new Set([...profile.exactTitles, ...profile.adjacentTitles, ...profile.excludedTitles].map((t) => t.toLocaleLowerCase('tr')));
    const additions = ((r.output as { adjacentTitles: string[] }).adjacentTitles ?? []).map((t) => t.trim()).filter((t) => t && !taken.has(t.toLocaleLowerCase('tr')) && taken.add(t.toLocaleLowerCase('tr')));
    if (!additions.length) return { added: 0 };
    const updated = await this.prisma.searchProfile.update({ where: { id: profile.id }, data: { adjacentTitles: [...profile.adjacentTitles, ...additions], revision: { increment: 1 } } });
    await this.outbox.emit({ workspaceId: profile.workspaceId, eventType: 'evaluate.profile', aggregateId: profile.id, dedupKey: `eval-profile:${profile.id}:${updated.revision}` });
    return { added: additions.length };
  }

  async discover(workspaceId: string, opts: { searchProfileId?: string; limit?: number; actorId?: string | null; allowManual?: boolean; focus?: string } = {}) {
    const profiles = opts.searchProfileId
      ? await this.prisma.searchProfile.findMany({ where: { id: opts.searchProfileId, workspaceId, active: true } })
      : await this.prisma.searchProfile.findMany({ where: { workspaceId, active: true }, orderBy: { createdAt: 'asc' } });
    if (profiles.length === 0) return { status: 'no_profile' as const, created: 0, awaitingTaskIds: [] as string[] };
    let created = 0;
    const awaitingTaskIds: string[] = [];
    let provider: string | null = null;
    for (const profile of profiles) {
      if (profile.exactTitles.length === 0 && profile.adjacentTitles.length === 0) continue;
      const known = await this.prisma.company.findMany({ where: { workspaceId, canonicalDomain: { not: null } }, select: { canonicalDomain: true }, orderBy: { createdAt: 'desc' }, take: KNOWN_DOMAINS_IN_PROMPT });
      const hints = await this.models.discoveryHints(workspaceId);
      const r = await this.ai.run({
        workspaceId,
        kind: 'company_discovery',
        input: {
          exactTitles: profile.exactTitles,
          adjacentTitles: profile.adjacentTitles,
          excludedTitles: profile.excludedTitles,
          keywords: profile.keywords,
          sectors: profile.sectors,
          city: profile.city ?? (profile.districtsPrimary.join(', ') || 'İstanbul'),
          districts: [...profile.districtsPrimary, ...profile.districtsConditional],
          knownDomains: known.map((k) => k.canonicalDomain),
          limit: opts.limit ?? 10,
          focus: opts.focus ?? null,
          day: new Date().toISOString().slice(0, 10),
          ...(hints.length ? { hints } : {}),
        },
        createdById: opts.actorId ?? null,
        allowManual: opts.allowManual ?? true,
        allowTemplate: false,
        useCache: !opts.actorId,
        context: { searchProfileId: profile.id },
      });
      if (r.status === 'unavailable') continue;
      if (r.status === 'awaiting_user') {
        awaitingTaskIds.push(r.taskId);
        continue;
      }
      provider = r.provider;
      const createdNow = await this.applyDiscovery(workspaceId, r.output, r.taskId, { titles: [...profile.exactTitles, ...profile.adjacentTitles] });
      created += createdNow;
      if (opts.focus) await this.logSegment(profile.id, opts.focus, createdNow);
      await this.learning.record({
        workspaceId,
        kind: 'discovery',
        aiTaskId: r.taskId,
        features: { provider: r.provider, titles: profile.exactTitles, adjacentTitles: profile.adjacentTitles.length, city: profile.city, focus: opts.focus ?? null, limit: opts.limit ?? 10, knownDomains: known.length, hints: hints.length > 0 },
        outcome: { returned: ((r.output as { companies?: unknown[] }).companies ?? []).length, created: createdNow },
      });
    }
    const status = provider ? ('succeeded' as const) : awaitingTaskIds.length ? ('awaiting_user' as const) : ('no_provider' as const);
    return { status, provider, created, awaitingTaskIds };
  }

  private safeHttpUrl(u: unknown): string | null {
    if (typeof u !== 'string' || !u) return null;
    try {
      return assertSafeUrl(u).toString();
    } catch {
      return null;
    }
  }

  /** Kullanıcının adını yazdığı kurumu bulur ve ekler; sonuç arayüzün okuması için anahtar-değer kaydına yazılır. */
  async lookupCompany(workspaceId: string, lookupId: string, query: string, actorId: string | null) {
    const key = `${COMPANY_LOOKUP_PREFIX}${lookupId}`;
    const save = (result: Record<string, unknown>) => {
      const value = { ...result, workspaceId } as Prisma.InputJsonValue;
      return this.prisma.keyValue.upsert({ where: { key }, create: { key, value }, update: { value } });
    };
    const profile = await this.prisma.searchProfile.findFirst({ where: { workspaceId, active: true }, orderBy: { createdAt: 'asc' } });
    const r = await this.ai.run({
      workspaceId,
      kind: 'company_lookup',
      input: { query, exactTitles: profile?.exactTitles ?? [], adjacentTitles: profile?.adjacentTitles ?? [], city: profile?.city ?? 'İstanbul' },
      createdById: actorId,
      allowManual: false,
      allowTemplate: false,
      useCache: false,
    });
    if (r.status !== 'succeeded') return save({ status: 'failed', query, reason: 'AI şu an kullanılamıyor' });
    const best = ((r.output as { companies?: any[] }).companies ?? [])[0];
    if (!best) return save({ status: 'not_found', query });
    const domain = normalizeDomain(best.domain ?? null);
    const before = await this.prisma.company.findFirst({ where: { workspaceId, OR: [...(domain ? [{ canonicalDomain: domain }] : []), { normalizedName: normalizeCompanyName(best.name) }] }, select: { id: true } });
    await this.applyDiscovery(workspaceId, { companies: [{ ...best, signal: best.signal ?? 'sector_fit' }] }, r.taskId, { userTriggered: true, titles: [...(profile?.exactTitles ?? []), ...(profile?.adjacentTitles ?? [])] });
    const company = await this.prisma.company.findFirst({ where: { workspaceId, OR: [...(domain ? [{ canonicalDomain: domain }] : []), { normalizedName: normalizeCompanyName(best.name) }] }, select: { id: true, name: true, excluded: true } });
    if (!company) return save({ status: 'not_found', query });
    if (company.excluded) await this.prisma.company.update({ where: { id: company.id }, data: { excluded: false } });
    if (before) await this.outbox.emit({ workspaceId, eventType: 'research.company', aggregateId: company.id, dedupKey: `research:${company.id}:lookup:${lookupId}`, payload: { companyId: company.id, actorId, userTriggered: true } });
    return save({ status: before ? 'exists' : 'added', query, companyId: company.id, name: company.name, openRoles: (best.openRoles ?? []).length });
  }

  async lookupStatus(workspaceId: string, lookupId: string) {
    const kv = await this.prisma.keyValue.findUnique({ where: { key: `${COMPANY_LOOKUP_PREFIX}${lookupId}` } });
    const value = kv?.value as Record<string, unknown> | null;
    if (!value || value.workspaceId !== workspaceId) return { status: 'pending' };
    const { workspaceId: _owner, ...result } = value;
    return result;
  }

  /**
   * Keşif sonucunu uygular: yeni firma + resmî kariyer/ATS kaynağı; açık rol bilgisi yalnızca sinyal olarak not edilir.
   * titles: firmanın hangi unvanlar aranırken bulunduğu; ortak katalogda benzer arayan diğer çalışma alanlarıyla eşleştirir.
   * roleLinksAreListings: rol bağlantıları kariyer sayfası değil tekil ilan sayfalarıdır (ilan aramasından gelen sonuç).
   */
  async applyDiscovery(workspaceId: string, output: { companies?: any[] }, taskId: string, opts: { userTriggered?: boolean; titles?: string[]; roleLinksAreListings?: boolean } = {}) {
    let created = 0;
    for (const c of output.companies ?? []) {
      const domain = normalizeDomain(c.domain ?? null);
      const normalizedName = normalizeCompanyName(c.name);
      const roles = ((c.openRoles ?? []) as { title: string; url?: string | null }[]).slice(0, 10);
      const signalNote = [
        `Keşif (${c.signal === 'open_role' ? 'açık rol sinyali' : 'sektör uyumu'}): ${c.reason} (kaynak: ${c.sourceUrl})`,
        ...roles.map((r) => `• Görülen rol: ${r.title}${r.url ? ` — ${r.url}` : ''}`),
      ].join('\n');
      let company = await this.prisma.company.findFirst({ where: { workspaceId, OR: [...(domain ? [{ canonicalDomain: domain }] : []), { normalizedName }] } });
      const isNew = !company;
      if (!company) {
        company = await this.prisma.company.create({
          data: {
            workspaceId,
            name: c.name,
            normalizedName,
            canonicalDomain: domain,
            website: domain ? `https://${domain}` : null,
            sectors: c.sectors ?? [],
            origin: 'discovery',
            notes: signalNote,
            importRef: `ai:${taskId}`,
          },
        });
        if (c.officeAddress || c.officeCity) {
          await this.applyOffices(company.id, [{ label: 'Ofis', city: c.officeCity ?? null, district: c.district ?? null, address: c.officeAddress ?? null, sourceUrl: c.officeSource ?? null }]);
        } else if (c.district) {
          await this.prisma.office.create({ data: { companyId: company.id, district: c.district, city: 'İstanbul', kind: 'hq', label: 'Keşif sırasında bildirilen', locationConfidence: 'low' } });
        }
        created++;
      } else if (c.signal === 'open_role' && roles.length && !(company.notes ?? '').includes(roles[0].title)) {
        company = await this.prisma.company.update({ where: { id: company.id }, data: { notes: [company.notes, signalNote].filter(Boolean).join('\n\n') } });
      }
      if (c.hrEmail && c.hrEmailSource) await this.applyContacts(company.id, [{ email: c.hrEmail, sourceUrl: c.hrEmailSource }]);
      await this.applySize(company.id, c.employees);
      // Resmî kariyer sayfası ve ATS panosu takip kaynağı olur; ilanlar yalnızca bu kaynakların taranmasıyla oluşur.
      // İlan aramasından gelen rol bağlantısı tekil bir ilan sayfasıdır; yalnızca başvuru panosuna aitse izlenecek kaynak olur.
      const roleLinks = roles.map((r) => this.safeHttpUrl(r.url)).filter((url) => !opts.roleLinksAreListings || (!!url && !!detectAtsSource(url)));
      const links = [this.safeHttpUrl(c.careersUrl), this.safeHttpUrl(c.atsUrl), ...roleLinks].filter(Boolean) as string[];
      if (links.length) await this.registerDiscoveredSources(company, links, { explicitCareersUrl: this.safeHttpUrl(c.careersUrl) });
      if (isNew) {
        await this.outbox.emit({ workspaceId, eventType: 'research.company', aggregateId: company.id, dedupKey: `research:${company.id}:discovery`, payload: { companyId: company.id, userTriggered: opts.userTriggered === true } });
      } else if (links.length) {
        await this.outbox.emit({ workspaceId, eventType: 'collect.all', aggregateId: workspaceId, dedupKey: `collect-all:${workspaceId}:discovery:${taskId}`, payload: {} });
      }
      await this.catalog.publish(company.id, { discoveredFor: opts.titles });
    }
    return created;
  }
}
