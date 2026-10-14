import { Body, Controller, Delete, Get, Injectable, Module, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AuditService } from '../../common/audit.service';
import { Ctx, RequestContext } from '../../common/auth';
import { AppError, notFound } from '../../common/errors';
import { OutboxService } from '../../common/outbox.service';
import { cursorArgs, paginate, pageQuery } from '../../common/pagination';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { ZodPipe } from '../../common/zod.pipe';
import { classifyPublishedEmail, domainMatches, isValidEmail } from '../../domain/contacts';
import { detectLocation } from '../../domain/geo';
import { CATEGORY_LABELS, Q_DIMENSIONS, Q_LABELS } from '../../domain/scoring';
import { normalizeCompanyName, normalizeDomain } from '../../domain/text';
import { AddressBookService } from '../../engine/address-book.service';
import { CatalogService } from '../../engine/catalog.service';
import { CompanyScoringService } from '../../engine/company-scoring.service';
import { SendingService } from '../../engine/sending.service';

const DEAD_ADDRESS_MESSAGE = 'Bu adres geçersiz olduğu için bir daha kullanılmıyor';

const companySchema = z.object({
  name: z.string().min(1).max(200),
  website: z.string().max(300).optional().nullable(),
  legalName: z.string().max(200).optional().nullable(),
  aliases: z.array(z.string()).default([]),
  groupName: z.string().max(200).optional().nullable(),
  sectors: z.array(z.string()).default([]),
  services: z.array(z.string()).default([]),
  description: z.string().max(4000).optional().nullable(),
  careersUrl: z.string().max(500).optional().nullable(),
  notes: z.string().max(8000).optional().nullable(),
  watch: z.boolean().default(false),
  excluded: z.boolean().default(false),
  excludedReason: z.string().max(300).optional().nullable(),
  district: z.string().max(80).optional().nullable(),
  address: z.string().max(400).optional().nullable(),
});
const listQuery = pageQuery.extend({
  search: z.string().optional(),
  sector: z.string().optional(),
  district: z.string().optional(),
  minQ: z.coerce.number().optional(),
  watch: z.enum(['true', 'false']).optional(),
  sort: z.enum(['q', 'name', 'recent']).default('q'),
});
const officeSchema = z.object({
  label: z.string().max(120).optional().nullable(),
  kind: z.enum(['hq', 'office', 'studio']).default('office'),
  address: z.string().max(400).optional().nullable(),
  city: z.string().max(80).optional().nullable(),
  district: z.string().max(80).optional().nullable(),
  lat: z.number().optional().nullable(),
  lng: z.number().optional().nullable(),
  locationConfidence: z.enum(['low', 'medium', 'high']).default('medium'),
});
const evidenceSchema = z.object({
  dimension: z.enum(['customer', 'campaign', 'reputation', 'service_fit', 'production']),
  customerName: z.string().max(120).optional().nullable(),
  scope: z.enum(['local', 'global', 'unknown']).default('unknown'),
  claimType: z.enum(['logo_wall', 'dated_case', 'independent', 'award', 'team', 'service', 'news', 'other']),
  title: z.string().min(1).max(200),
  summary: z.string().max(2000).optional().nullable(),
  url: z.string().max(500).optional().nullable(),
  evidenceDate: z.string().optional().nullable(),
  confidence: z.enum(['low', 'medium', 'high']).default('medium'),
  accepted: z.boolean().default(true),
});
const contactSchema = z.object({
  name: z.string().max(120).optional().nullable(),
  role: z.string().max(120).optional().nullable(),
  email: z.string().email().transform((v) => v.toLowerCase().trim()),
  kind: z.enum(['official_hr', 'job_apply', 'general', 'named_recruiter', 'guessed']).optional(),
  purpose: z.string().max(300).optional().nullable(),
  sourceUrl: z.string().max(500).optional().nullable(),
  verified: z.boolean().default(false),
  ownershipEvidence: z.string().max(500).optional().nullable(),
  confidence: z.enum(['low', 'medium', 'high']).optional(),
});
const qualitySchema = z.record(z.enum(Q_DIMENSIONS), z.object({ score: z.union([z.literal(0), z.literal(0.5), z.literal(1), z.null()]), note: z.string().max(300).optional() }).nullable());
const suppressionSchema = z.object({
  candidateId: z.string().optional().nullable(),
  companyId: z.string().optional().nullable(),
  contactEmail: z.string().email().optional().nullable(),
  domain: z.string().optional().nullable(),
  reason: z.string().min(1).max(300),
});
const discoverySchema = z.object({
  domains: z.array(z.string()).max(100).default([]),
  aiDiscovery: z.boolean().default(false),
  searchProfileId: z.string().optional(),
  limit: z.number().int().min(1).max(30).default(10),
  collectSources: z.boolean().default(true),
});

@Injectable()
export class CompaniesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly scoring: CompanyScoringService,
    private readonly sending: SendingService,
    private readonly catalog: CatalogService,
    private readonly addressBook: AddressBookService,
  ) {}

  async list(ctx: RequestContext, q: z.infer<typeof listQuery>) {
    const where: Prisma.CompanyWhereInput = { workspaceId: ctx.workspaceId };
    if (q.search) where.OR = [{ name: { contains: q.search, mode: 'insensitive' } }, { canonicalDomain: { contains: q.search.toLowerCase() } }];
    if (q.sector) where.sectors = { has: q.sector };
    if (q.minQ !== undefined) where.qScore = { gte: q.minQ };
    if (q.watch) where.watch = q.watch === 'true';
    if (q.district) where.offices = { some: { district: q.district } };
    const orderBy: Prisma.CompanyOrderByWithRelationInput[] =
      q.sort === 'name' ? [{ name: 'asc' }] : q.sort === 'recent' ? [{ createdAt: 'desc' }] : [{ qScore: { sort: 'desc', nulls: 'last' } }, { name: 'asc' }];
    const rows = await this.prisma.company.findMany({
      where,
      orderBy: [...orderBy, { id: 'asc' }],
      ...cursorArgs(q),
      include: {
        offices: { select: { district: true, city: true, kind: true } },
        _count: { select: { jobs: true, contacts: true, evidence: true } },
        jobs: { where: { status: 'open' }, select: { id: true, title: true }, take: 3 },
        opportunities: { select: { category: true, f: true, searchProfileId: true }, orderBy: { f: { sort: 'desc', nulls: 'last' } }, take: 1 },
      },
    });
    return paginate(rows, q.limit);
  }

  async get(ctx: RequestContext, id: string) {
    await this.scope.company(ctx, id);
    const company = await this.prisma.company.findUniqueOrThrow({
      where: { id },
      include: {
        offices: true,
        evidence: { orderBy: [{ dimension: 'asc' }, { evidenceDate: { sort: 'desc', nulls: 'last' } }] },
        contacts: { orderBy: { kind: 'asc' } },
        jobs: { include: { listings: { include: { source: { select: { id: true, name: true, kind: true, health: true } } } } }, orderBy: { lastSeenAt: 'desc' } },
        sources: true,
        opportunities: { include: { searchProfile: { select: { id: true, name: true } } } },
      },
    });
    const attempts = await this.prisma.applicationAttempt.findMany({ where: { companyId: id, workspaceId: ctx.workspaceId }, orderBy: { createdAt: 'desc' } });
    const suppressions = await this.prisma.suppression.findMany({ where: { workspaceId: ctx.workspaceId, companyId: id } });
    return {
      ...company,
      attempts,
      suppressions,
      qualityLabels: Q_LABELS,
      categoryLabels: CATEGORY_LABELS,
    };
  }

  async create(ctx: RequestContext, input: z.infer<typeof companySchema>) {
    const domain = normalizeDomain(input.website);
    if (domain) {
      const dup = await this.prisma.company.findFirst({ where: { workspaceId: ctx.workspaceId, canonicalDomain: domain } });
      if (dup) throw new AppError(409, 'COMPANY_EXISTS', `Bu alan adıyla kayıtlı firma var: ${dup.name}`, { companyId: dup.id });
    }
    const { district, address, ...rest } = input;
    const company = await this.prisma.$transaction(async (tx) => {
      const c = await tx.company.create({
        data: {
          ...rest,
          workspaceId: ctx.workspaceId,
          normalizedName: normalizeCompanyName(input.name),
          canonicalDomain: domain,
          website: input.website ? (input.website.startsWith('http') ? input.website : `https://${input.website}`) : null,
          origin: 'manual',
        },
      });
      if (district || address) {
        const loc = detectLocation(`${address ?? ''} ${district ?? ''}`);
        await tx.office.create({ data: { companyId: c.id, kind: 'hq', address, district: district ?? loc.district, city: loc.city ?? 'İstanbul', locationConfidence: district ? 'high' : 'medium' } });
      }
      if (input.careersUrl) {
        await tx.sourceConnector.create({
          data: { workspaceId: ctx.workspaceId, companyId: c.id, kind: 'career_page', name: `${c.name} — Kariyer sayfası`, config: { url: input.careersUrl }, accessMode: 'html', capabilities: ['discover', 'detail', 'verify'], intervalMinutes: 45, minIntervalMinutes: 30, nextRunAt: new Date() },
        });
      }
      await this.outbox.emit({ workspaceId: ctx.workspaceId, eventType: 'evaluate.company', aggregateId: c.id, dedupKey: `eval-company:${c.id}:create`, payload: { companyId: c.id } }, tx);
      return c;
    });
    await this.audit.log({ workspaceId: ctx.workspaceId, actorId: ctx.userId, action: 'company.create', entityType: 'Company', entityId: company.id });
    return company;
  }

  async update(ctx: RequestContext, id: string, input: Partial<z.infer<typeof companySchema>>) {
    const prev = await this.scope.company(ctx, id);
    const { district: _d, address: _a, ...rest } = input;
    const data: Prisma.CompanyUpdateInput = { ...rest };
    if (input.name) data.normalizedName = normalizeCompanyName(input.name);
    if (input.website !== undefined) data.canonicalDomain = normalizeDomain(input.website);
    const c = await this.prisma.company.update({ where: { id }, data });
    await this.outbox.emit({ workspaceId: ctx.workspaceId, eventType: 'evaluate.company', aggregateId: id, dedupKey: `eval-company:${id}:upd:${Date.now()}`, payload: { companyId: id } });
    await this.audit.log({ workspaceId: ctx.workspaceId, actorId: ctx.userId, action: 'company.update', entityType: 'Company', entityId: id, previous: { name: prev.name, sectors: prev.sectors, excluded: prev.excluded }, next: { name: c.name, sectors: c.sectors, excluded: c.excluded } });
    return c;
  }

  async remove(ctx: RequestContext, id: string) {
    await this.scope.company(ctx, id);
    await this.catalog.forget(ctx.workspaceId, id);
    await this.prisma.$transaction(async (tx) => {
      // Silinen firmaya kuyruktaki gönderim ve bekleyen takipler durdurulur.
      await this.sending.cancelQueued({ workspaceId: ctx.workspaceId, companyId: id }, 'COMPANY_DELETED', tx);
      const attemptIds = (await tx.applicationAttempt.findMany({ where: { workspaceId: ctx.workspaceId, companyId: id }, select: { id: true } })).map((a) => a.id);
      await tx.followUp.updateMany({ where: { attemptId: { in: attemptIds }, state: 'pending' }, data: { state: 'cancelled', cancellationReason: 'COMPANY_DELETED' } });
      await tx.applicationDraft.updateMany({ where: { workspaceId: ctx.workspaceId, companyId: id, status: { in: ['draft', 'needs_review'] } }, data: { status: 'cancelled' } });
      await tx.company.delete({ where: { id } });
    });
    await this.audit.log({ workspaceId: ctx.workspaceId, actorId: ctx.userId, action: 'company.delete', entityType: 'Company', entityId: id });
    return { ok: true };
  }

  async addOffice(ctx: RequestContext, companyId: string, input: z.infer<typeof officeSchema>) {
    await this.scope.company(ctx, companyId);
    const o = await this.prisma.office.create({ data: { ...input, companyId } });
    await this.outbox.emit({ workspaceId: ctx.workspaceId, eventType: 'evaluate.company', aggregateId: companyId, dedupKey: `eval-company:${companyId}:office:${o.id}`, payload: { companyId } });
    return o;
  }

  async updateOffice(ctx: RequestContext, id: string, input: Partial<z.infer<typeof officeSchema>>) {
    const o = await this.prisma.office.findFirst({ where: { id, company: { workspaceId: ctx.workspaceId } } });
    if (!o) throw notFound('Ofis');
    return this.prisma.office.update({ where: { id }, data: input });
  }

  async removeOffice(ctx: RequestContext, id: string) {
    const o = await this.prisma.office.findFirst({ where: { id, company: { workspaceId: ctx.workspaceId } } });
    if (!o) throw notFound('Ofis');
    await this.prisma.office.delete({ where: { id } });
    return { ok: true };
  }

  async addEvidence(ctx: RequestContext, companyId: string, input: z.infer<typeof evidenceSchema>) {
    await this.scope.company(ctx, companyId);
    const e = await this.prisma.companyEvidence.create({
      data: { ...input, evidenceDate: input.evidenceDate ? new Date(input.evidenceDate) : null, companyId, workspaceId: ctx.workspaceId, createdBy: 'user' },
    });
    await this.afterEvidence(ctx, companyId);
    return e;
  }

  async updateEvidence(ctx: RequestContext, id: string, input: Partial<z.infer<typeof evidenceSchema>>) {
    const e = await this.prisma.companyEvidence.findFirst({ where: { id, workspaceId: ctx.workspaceId } });
    if (!e) throw notFound('Kanıt');
    const u = await this.prisma.companyEvidence.update({
      where: { id },
      data: { ...input, evidenceDate: input.evidenceDate === undefined ? undefined : input.evidenceDate ? new Date(input.evidenceDate) : null },
    });
    await this.afterEvidence(ctx, e.companyId);
    return u;
  }

  async removeEvidence(ctx: RequestContext, id: string) {
    const e = await this.prisma.companyEvidence.findFirst({ where: { id, workspaceId: ctx.workspaceId } });
    if (!e) throw notFound('Kanıt');
    await this.prisma.companyEvidence.delete({ where: { id } });
    await this.afterEvidence(ctx, e.companyId);
    return { ok: true };
  }

  private async afterEvidence(ctx: RequestContext, companyId: string) {
    await this.scoring.recompute(companyId);
    await this.outbox.emit({ workspaceId: ctx.workspaceId, eventType: 'evaluate.company', aggregateId: companyId, dedupKey: `eval-company:${companyId}:ev:${Date.now()}`, payload: { companyId } });
  }

  async setQuality(ctx: RequestContext, companyId: string, input: z.infer<typeof qualitySchema>) {
    const c = await this.scope.company(ctx, companyId);
    const dims = { ...((c.qualityDims ?? {}) as Record<string, any>) };
    for (const [k, v] of Object.entries(input)) {
      if (v === null) dims[k] = { ...(dims[k] ?? {}), override: false };
      else dims[k] = { ...(dims[k] ?? {}), score: v.score, note: v.note, override: true };
    }
    await this.prisma.company.update({ where: { id: companyId }, data: { qualityDims: dims } });
    const r = await this.scoring.recompute(companyId);
    await this.outbox.emit({ workspaceId: ctx.workspaceId, eventType: 'evaluate.company', aggregateId: companyId, dedupKey: `eval-company:${companyId}:q:${Date.now()}`, payload: { companyId } });
    await this.audit.log({ workspaceId: ctx.workspaceId, actorId: ctx.userId, action: 'company.quality', entityType: 'Company', entityId: companyId, next: input });
    return r;
  }

  async addContact(ctx: RequestContext, companyId: string, input: z.infer<typeof contactSchema>) {
    const company = await this.scope.company(ctx, companyId);
    if (!isValidEmail(input.email)) throw new AppError(400, 'EMAIL_INVALID', 'Geçersiz e-posta');
    if (await this.addressBook.isDead(input.email)) throw new AppError(422, 'DEAD_ADDRESS', DEAD_ADDRESS_MESSAGE);
    const cls = classifyPublishedEmail(input.email);
    const official = domainMatches(input.email, company.canonicalDomain, company.aliases);
    const c = await this.prisma.contactPoint.create({
      data: {
        workspaceId: ctx.workspaceId,
        companyId,
        name: input.name,
        role: input.role,
        email: input.email,
        kind: input.kind ?? cls.kind,
        purpose: input.purpose ?? cls.note ?? null,
        sourceUrl: input.sourceUrl,
        ownershipEvidence: input.ownershipEvidence ?? (official ? 'Alan adı firma domaini ile eşleşiyor' : null),
        confidence: input.confidence ?? (official ? 'medium' : 'low'),
        verifiedAt: input.verified ? new Date() : null,
        verifiedBy: input.verified ? 'user' : null,
      },
    });
    await this.audit.log({ workspaceId: ctx.workspaceId, actorId: ctx.userId, action: 'contact.create', entityType: 'ContactPoint', entityId: c.id });
    return c;
  }

  async updateContact(ctx: RequestContext, id: string, input: Partial<z.infer<typeof contactSchema>> & { suppressed?: boolean }) {
    const c = await this.prisma.contactPoint.findFirst({ where: { id, workspaceId: ctx.workspaceId } });
    if (!c) throw notFound('İletişim');
    if (input.suppressed === false && (await this.addressBook.isDead(c.email))) throw new AppError(422, 'DEAD_ADDRESS', DEAD_ADDRESS_MESSAGE);
    const { verified, ...rest } = input;
    const u = await this.prisma.contactPoint.update({
      where: { id },
      data: {
        ...rest,
        ...(verified === true ? { verifiedAt: new Date(), verifiedBy: 'user' } : verified === false ? { verifiedAt: null, verifiedBy: null } : {}),
      },
    });
    await this.audit.log({ workspaceId: ctx.workspaceId, actorId: ctx.userId, action: 'contact.update', entityType: 'ContactPoint', entityId: id, previous: { kind: c.kind, verifiedAt: c.verifiedAt }, next: { kind: u.kind, verifiedAt: u.verifiedAt } });
    return u;
  }

  async removeContact(ctx: RequestContext, id: string) {
    const c = await this.prisma.contactPoint.findFirst({ where: { id, workspaceId: ctx.workspaceId } });
    if (!c) throw notFound('İletişim');
    await this.prisma.contactPoint.delete({ where: { id } });
    return { ok: true };
  }

  async research(ctx: RequestContext, id: string) {
    await this.scope.company(ctx, id);
    // API isteğini bekletmemek için arka plan işine bırakılır.
    await this.outbox.emit({ workspaceId: ctx.workspaceId, eventType: 'research.company', aggregateId: id, dedupKey: `research:${id}:${Date.now()}`, payload: { companyId: id, actorId: ctx.userId } });
    return { queued: true };
  }

  async discovery(ctx: RequestContext, input: z.infer<typeof discoverySchema>) {
    let created = 0;
    const existing: string[] = [];
    for (const raw of input.domains) {
      const domain = normalizeDomain(raw);
      if (!domain) continue;
      const dup = await this.prisma.company.findFirst({ where: { workspaceId: ctx.workspaceId, canonicalDomain: domain } });
      if (dup) {
        existing.push(dup.id);
        await this.outbox.emit({ workspaceId: ctx.workspaceId, eventType: 'research.company', aggregateId: dup.id, dedupKey: `research:${dup.id}:${Date.now()}`, payload: { companyId: dup.id } });
        continue;
      }
      const c = await this.prisma.company.create({
        data: { workspaceId: ctx.workspaceId, name: domain.split('.')[0].replace(/-/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase()), normalizedName: normalizeCompanyName(domain.split('.')[0]), canonicalDomain: domain, website: `https://${domain}`, origin: 'discovery' },
      });
      await this.outbox.emit({ workspaceId: ctx.workspaceId, eventType: 'research.company', aggregateId: c.id, dedupKey: `research:${c.id}:discovery`, payload: { companyId: c.id, actorId: ctx.userId } });
      created++;
    }
    if (input.aiDiscovery) {
      await this.outbox.emit({ workspaceId: ctx.workspaceId, eventType: 'discovery.ai', aggregateId: ctx.workspaceId, dedupKey: `discovery:${ctx.workspaceId}:${Date.now()}`, payload: { searchProfileId: input.searchProfileId, limit: input.limit, actorId: ctx.userId } });
    }
    if (input.collectSources) {
      await this.outbox.emit({ workspaceId: ctx.workspaceId, eventType: 'collect.all', aggregateId: ctx.workspaceId, dedupKey: `collect-all:${ctx.workspaceId}:${Date.now()}`, payload: {} });
    }
    await this.audit.log({ workspaceId: ctx.workspaceId, actorId: ctx.userId, action: 'discovery.run', entityType: 'Workspace', entityId: ctx.workspaceId, next: { domains: input.domains.length, aiDiscovery: input.aiDiscovery } });
    return { created, existing: existing.length, aiDiscoveryQueued: input.aiDiscovery };
  }

  listSuppressions(ctx: RequestContext) {
    return this.prisma.suppression.findMany({ where: { workspaceId: ctx.workspaceId }, orderBy: { createdAt: 'desc' } });
  }

  async addSuppression(ctx: RequestContext, input: z.infer<typeof suppressionSchema>) {
    if (!input.companyId && !input.contactEmail && !input.domain) throw new AppError(400, 'SCOPE_REQUIRED', 'Firma, e-posta veya alan adı belirtilmeli');
    if (input.companyId) await this.scope.company(ctx, input.companyId);
    if (input.candidateId) await this.scope.candidate(ctx, input.candidateId);
    const s = await this.prisma.$transaction(async (tx) => {
      const s = await tx.suppression.create({ data: { ...input, domain: normalizeDomain(input.domain), contactEmail: input.contactEmail?.toLowerCase(), workspaceId: ctx.workspaceId } });
      // Kara liste yeni otomatik temasları ve kuyruktaki işleri durdurur.
      if (input.companyId) {
        await this.sending.cancelQueued({ workspaceId: ctx.workspaceId, companyId: input.companyId }, 'SUPPRESSED', tx);
        await tx.followUp.updateMany({ where: { workspaceId: ctx.workspaceId, state: 'pending', attemptId: { in: (await tx.applicationAttempt.findMany({ where: { companyId: input.companyId }, select: { id: true } })).map((a) => a.id) } }, data: { state: 'cancelled', cancellationReason: 'SUPPRESSED' } });
      }
      return s;
    });
    await this.audit.log({ workspaceId: ctx.workspaceId, actorId: ctx.userId, action: 'suppression.create', entityType: 'Suppression', entityId: s.id, reason: input.reason });
    return s;
  }

  async removeSuppression(ctx: RequestContext, id: string) {
    const s = await this.prisma.suppression.findFirst({ where: { id, workspaceId: ctx.workspaceId } });
    if (!s) throw notFound('Kara liste kaydı');
    await this.prisma.suppression.delete({ where: { id } });
    await this.audit.log({ workspaceId: ctx.workspaceId, actorId: ctx.userId, action: 'suppression.delete', entityType: 'Suppression', entityId: id });
    return { ok: true };
  }
}

@Controller('v1')
export class CompaniesController {
  constructor(private readonly svc: CompaniesService) {}

  @Get('companies')
  list(@Ctx() ctx: RequestContext, @Query(new ZodPipe(listQuery)) q: z.infer<typeof listQuery>) {
    return this.svc.list(ctx, q);
  }

  @Get('companies/:id')
  get(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.svc.get(ctx, id);
  }

  @Post('companies')
  create(@Ctx() ctx: RequestContext, @Body(new ZodPipe(companySchema)) body: z.infer<typeof companySchema>) {
    return this.svc.create(ctx, body);
  }

  @Patch('companies/:id')
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new ZodPipe(companySchema.partial())) body: Partial<z.infer<typeof companySchema>>) {
    return this.svc.update(ctx, id, body);
  }

  @Delete('companies/:id')
  remove(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.svc.remove(ctx, id);
  }

  @Post('companies/:id/offices')
  addOffice(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new ZodPipe(officeSchema)) body: z.infer<typeof officeSchema>) {
    return this.svc.addOffice(ctx, id, body);
  }

  @Patch('offices/:id')
  updateOffice(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new ZodPipe(officeSchema.partial())) body: Partial<z.infer<typeof officeSchema>>) {
    return this.svc.updateOffice(ctx, id, body);
  }

  @Delete('offices/:id')
  removeOffice(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.svc.removeOffice(ctx, id);
  }

  @Post('companies/:id/evidence')
  addEvidence(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new ZodPipe(evidenceSchema)) body: z.infer<typeof evidenceSchema>) {
    return this.svc.addEvidence(ctx, id, body);
  }

  @Patch('evidence/:id')
  updateEvidence(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new ZodPipe(evidenceSchema.partial())) body: Partial<z.infer<typeof evidenceSchema>>) {
    return this.svc.updateEvidence(ctx, id, body);
  }

  @Delete('evidence/:id')
  removeEvidence(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.svc.removeEvidence(ctx, id);
  }

  @Put('companies/:id/quality')
  setQuality(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new ZodPipe(qualitySchema)) body: z.infer<typeof qualitySchema>) {
    return this.svc.setQuality(ctx, id, body);
  }

  @Post('companies/:id/contacts')
  addContact(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new ZodPipe(contactSchema)) body: z.infer<typeof contactSchema>) {
    return this.svc.addContact(ctx, id, body);
  }

  @Patch('contacts/:id')
  updateContact(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Body(new ZodPipe(contactSchema.partial().extend({ suppressed: z.boolean().optional() }))) body: Partial<z.infer<typeof contactSchema>> & { suppressed?: boolean },
  ) {
    return this.svc.updateContact(ctx, id, body);
  }

  @Delete('contacts/:id')
  removeContact(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.svc.removeContact(ctx, id);
  }

  @Post('companies/:id/research')
  research(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.svc.research(ctx, id);
  }

  @Post('discovery-runs')
  discovery(@Ctx() ctx: RequestContext, @Body(new ZodPipe(discoverySchema)) body: z.infer<typeof discoverySchema>) {
    return this.svc.discovery(ctx, body);
  }

  @Get('suppressions')
  suppressions(@Ctx() ctx: RequestContext) {
    return this.svc.listSuppressions(ctx);
  }

  @Post('suppressions')
  addSuppression(@Ctx() ctx: RequestContext, @Body(new ZodPipe(suppressionSchema)) body: z.infer<typeof suppressionSchema>) {
    return this.svc.addSuppression(ctx, body);
  }

  @Delete('suppressions/:id')
  removeSuppression(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.svc.removeSuppression(ctx, id);
  }
}

@Module({ controllers: [CompaniesController], providers: [CompaniesService] })
export class CompaniesModule {}
