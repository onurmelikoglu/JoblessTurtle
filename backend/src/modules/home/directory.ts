import { Controller, Get, Injectable, Param } from '@nestjs/common';
import { Ctx, RequestContext } from '../../common/auth';
import { notFound } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import type { DirectoryApplication, DirectoryCompany, DirectoryCompanyDetail, DirectoryJob, DirectoryList, DirectoryMessage } from '../../contracts/directory';
import { ServerShape } from '../../contracts/wire';
import { employeeSizeOf } from '../../domain/company-size';

const ACTIVE_JOB_STATES = ['open', 'unknown', 'stale'];
const COUNTED_ATTEMPT = { state: { not: 'cancelled' } };
const OPEN_OPPORTUNITY = { status: { notIn: ['dismissed', 'applied'] }, category: { not: 'excluded' } };
const DETAIL_JOB_LIMIT = 200;
const DETAIL_MESSAGE_LIMIT = 300;

const latest = (a: Date | null | undefined, b: Date | null | undefined) => (!a ? (b ?? null) : !b ? a : a > b ? a : b);

/** Son başvurudan sonra ilk görülen ya da yeniden açılan ilan. */
export function openedSince(job: { firstSeenAt: Date; reopenedAt: Date | null }, lastAppliedAt: Date | null): boolean {
  if (!lastAppliedAt) return false;
  return job.firstSeenAt > lastAppliedAt || (!!job.reopenedAt && job.reopenedAt > lastAppliedAt);
}

const distinct = (values: (string | null | undefined)[]) => [...new Map(values.filter((v): v is string => !!v?.trim()).map((v) => [v.trim().toLocaleLowerCase('tr'), v.trim()])).values()];

/**
 * Şirketler sayfası: başvurulmuş olanlar dahil her firma. Liste tek seferde döner (Firmalar sekmesi gibi), süzme ve
 * sıralama tarayıcıda yapılır; birleştirilmiş yönlendirme kayıtları ve başvurusu olmayan gizlenmiş firmalar listelenmez.
 */
@Injectable()
export class DirectoryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(ctx: RequestContext): Promise<ServerShape<DirectoryList>> {
    const workspaceId = ctx.workspaceId;
    const [companies, jobGroups, attempts, opportunityGroups] = await Promise.all([
      this.prisma.company.findMany({
        where: { workspaceId, mergedIntoId: null },
        select: { id: true, name: true, aliases: true, website: true, sectors: true, employeeRange: true, employeeCount: true, excluded: true, createdAt: true, offices: { select: { city: true } } },
      }),
      this.prisma.job.groupBy({ by: ['companyId', 'status'], where: { workspaceId }, _count: { _all: true }, _max: { firstSeenAt: true } }),
      this.prisma.applicationAttempt.findMany({ where: { workspaceId, ...COUNTED_ATTEMPT }, select: { id: true, companyId: true, createdAt: true, acceptedAt: true } }),
      this.prisma.opportunity.groupBy({ by: ['companyId'], where: { workspaceId, ...OPEN_OPPORTUNITY }, _count: { _all: true } }),
    ]);
    const replies = attempts.length
      ? await this.prisma.inboundMessage.groupBy({ by: ['attemptId'], where: { attemptId: { in: attempts.map((a) => a.id) } }, _count: { _all: true }, _max: { receivedAt: true } })
      : [];

    const applied = new Map<string, { count: number; last: Date | null; replies: number; lastReply: Date | null }>();
    const companyOfAttempt = new Map(attempts.map((a) => [a.id, a.companyId]));
    for (const a of attempts) {
      const entry = applied.get(a.companyId) ?? { count: 0, last: null, replies: 0, lastReply: null };
      entry.count++;
      entry.last = latest(entry.last, a.acceptedAt ?? a.createdAt);
      applied.set(a.companyId, entry);
    }
    for (const r of replies) {
      const entry = r.attemptId ? applied.get(companyOfAttempt.get(r.attemptId) ?? '') : undefined;
      if (!entry) continue;
      entry.replies += r._count._all;
      entry.lastReply = latest(entry.lastReply, r._max.receivedAt);
    }

    const jobs = new Map<string, { open: number; total: number; last: Date | null }>();
    for (const g of jobGroups) {
      const entry = jobs.get(g.companyId) ?? { open: 0, total: 0, last: null };
      entry.total += g._count._all;
      if (g.status === 'open') entry.open += g._count._all;
      entry.last = latest(entry.last, g._max.firstSeenAt);
      jobs.set(g.companyId, entry);
    }

    const appliedIds = [...applied.keys()];
    const recentJobs = appliedIds.length
      ? await this.prisma.job.findMany({ where: { companyId: { in: appliedIds }, status: { in: ACTIVE_JOB_STATES } }, select: { companyId: true, firstSeenAt: true, reopenedAt: true } })
      : [];
    const newSince = new Map<string, number>();
    for (const j of recentJobs) if (openedSince(j, applied.get(j.companyId)?.last ?? null)) newSince.set(j.companyId, (newSince.get(j.companyId) ?? 0) + 1);
    const withOpportunity = new Set(opportunityGroups.map((g) => g.companyId));

    const items: ServerShape<DirectoryCompany>[] = companies
      .filter((c) => !c.excluded || applied.has(c.id))
      .map((c) => {
        const a = applied.get(c.id);
        const j = jobs.get(c.id);
        return {
          id: c.id,
          name: c.name,
          aliases: c.aliases,
          website: c.website,
          cities: distinct(c.offices.map((o) => o.city)),
          sectors: c.sectors,
          employees: employeeSizeOf(c),
          openJobs: j?.open ?? 0,
          totalJobs: j?.total ?? 0,
          lastJobAt: j?.last ?? null,
          applications: a?.count ?? 0,
          lastAppliedAt: a?.last ?? null,
          replies: a?.replies ?? 0,
          lastReplyAt: a?.lastReply ?? null,
          newSinceApply: newSince.get(c.id) ?? 0,
          hasOpportunity: withOpportunity.has(c.id),
          foundAt: c.createdAt,
        };
      });
    return {
      companies: items,
      totals: {
        companies: items.length,
        applied: items.filter((c) => c.applications > 0).length,
        newSinceApply: items.filter((c) => c.newSinceApply > 0).length,
        replied: items.filter((c) => c.replies > 0).length,
      },
    };
  }

  async detail(ctx: RequestContext, id: string): Promise<ServerShape<DirectoryCompanyDetail>> {
    const company = await this.prisma.company.findFirst({
      where: { id, workspaceId: ctx.workspaceId },
      include: { offices: true, contacts: { where: { suppressed: false }, select: { email: true, kind: true } } },
    });
    if (!company) throw notFound('Firma');
    if (company.mergedIntoId) return this.detail(ctx, company.mergedIntoId);

    const [merged, jobs, attempts, opportunities] = await Promise.all([
      this.prisma.company.findMany({ where: { mergedIntoId: company.id }, select: { name: true } }),
      this.prisma.job.findMany({
        where: { companyId: company.id },
        orderBy: [{ status: 'asc' }, { lastSeenAt: 'desc' }],
        take: DETAIL_JOB_LIMIT,
        include: { listings: { select: { canonicalUrl: true, applyUrl: true }, take: 1 } },
      }),
      this.prisma.applicationAttempt.findMany({ where: { companyId: company.id, ...COUNTED_ATTEMPT }, orderBy: { createdAt: 'desc' } }),
      this.prisma.opportunity.findMany({ where: { companyId: company.id, ...OPEN_OPPORTUNITY }, select: { id: true, jobId: true } }),
    ]);
    const attemptIds = attempts.map((a) => a.id);
    const [revisions, inbound, stages] = await Promise.all([
      attempts.length ? this.prisma.draftRevision.findMany({ where: { OR: attempts.map((a) => ({ draftId: a.draftId, revision: a.draftRevision })) }, select: { draftId: true, revision: true, subject: true, body: true, toEmail: true } }) : [],
      attemptIds.length ? this.prisma.inboundMessage.findMany({ where: { attemptId: { in: attemptIds } }, orderBy: { receivedAt: 'desc' }, take: DETAIL_MESSAGE_LIMIT }) : [],
      attemptIds.length ? this.prisma.applicationStage.findMany({ where: { attemptId: { in: attemptIds } }, orderBy: { at: 'asc' }, select: { attemptId: true, stage: true } }) : [],
    ]);
    const revisionOf = new Map(revisions.map((r) => [`${r.draftId}:${r.revision}`, r]));
    const stageOf = new Map(stages.map((s) => [s.attemptId, s.stage]));
    const replyCount = new Map<string, number>();
    for (const m of inbound) if (m.attemptId) replyCount.set(m.attemptId, (replyCount.get(m.attemptId) ?? 0) + 1);
    const titleOf = new Map(jobs.map((j) => [j.id, j.title]));
    const missingTitles = attempts.filter((a) => a.jobId && !titleOf.has(a.jobId)).map((a) => a.jobId!);
    if (missingTitles.length) for (const j of await this.prisma.job.findMany({ where: { id: { in: missingTitles } }, select: { id: true, title: true } })) titleOf.set(j.id, j.title);

    const sentAt = (a: (typeof attempts)[number]) => a.acceptedAt ?? a.createdAt;
    const lastAppliedAt = attempts.reduce<Date | null>((last, a) => latest(last, sentAt(a)), null);
    const appliedJobs = new Set(attempts.map((a) => a.jobId).filter(Boolean));
    const opportunityOf = new Map(opportunities.filter((o) => o.jobId).map((o) => [o.jobId!, o.id]));

    const jobItems: ServerShape<DirectoryJob>[] = jobs.map((j) => ({
      id: j.id,
      title: j.title,
      status: j.status,
      location: j.locationText ?? ([j.district, j.city].filter(Boolean).join(', ') || null),
      workMode: j.workMode,
      firstSeenAt: j.firstSeenAt,
      lastSeenAt: j.lastSeenAt,
      closedAt: j.closedAt,
      reopenedAt: j.reopenedAt,
      url: j.applyUrl ?? j.listings[0]?.canonicalUrl ?? j.listings[0]?.applyUrl ?? null,
      newSinceApply: ACTIVE_JOB_STATES.includes(j.status) && openedSince(j, lastAppliedAt),
      applied: appliedJobs.has(j.id),
      opportunityId: opportunityOf.get(j.id) ?? null,
    }));

    const applications: ServerShape<DirectoryApplication>[] = attempts.map((a) => {
      const revision = revisionOf.get(`${a.draftId}:${a.draftRevision}`);
      return {
        id: a.id,
        title: a.jobId ? (titleOf.get(a.jobId) ?? null) : null,
        state: a.state,
        stage: stageOf.get(a.id) ?? null,
        outcome: a.outcome,
        sentAt: sentAt(a),
        toEmail: a.toEmail ?? revision?.toEmail ?? null,
        subject: revision?.subject ?? null,
        replyCount: replyCount.get(a.id) ?? 0,
      };
    });

    const outgoing: ServerShape<DirectoryMessage>[] = attempts.map((a) => {
      const revision = revisionOf.get(`${a.draftId}:${a.draftRevision}`);
      return { id: `out:${a.id}`, attemptId: a.id, direction: 'out', at: sentAt(a), from: null, to: a.toEmail ?? revision?.toEmail ?? null, subject: revision?.subject ?? null, snippet: revision?.body?.slice(0, 240) ?? null, category: null };
    });
    const incoming: ServerShape<DirectoryMessage>[] = inbound.map((m) => ({ id: m.id, attemptId: m.attemptId ?? '', direction: 'in', at: m.receivedAt, from: m.fromEmail, to: null, subject: m.subject, snippet: m.snippet, category: m.category ?? m.classification }));
    const messages = [...outgoing, ...incoming].sort((x, y) => y.at.getTime() - x.at.getTime());

    const replies = inbound.length;
    return {
      company: {
        id: company.id,
        name: company.name,
        aliases: company.aliases,
        website: company.website,
        careersUrl: company.careersUrl,
        phone: company.phone,
        workPolicy: company.workPolicy,
        cities: distinct(company.offices.map((o) => o.city)),
        sectors: company.sectors,
        employees: employeeSizeOf(company),
        openJobs: jobs.filter((j) => j.status === 'open').length,
        totalJobs: jobs.length,
        lastJobAt: jobs.reduce<Date | null>((last, j) => latest(last, j.firstSeenAt), null),
        applications: attempts.length,
        lastAppliedAt,
        replies,
        lastReplyAt: inbound[0]?.receivedAt ?? null,
        newSinceApply: jobItems.filter((j) => j.newSinceApply).length,
        hasOpportunity: opportunities.length > 0,
        foundAt: company.createdAt,
        offices: company.offices.map((o) => ({ label: o.label, city: o.city, district: o.district, address: o.address })),
        contacts: company.contacts,
        mergedNames: merged.map((m) => m.name),
      },
      jobs: jobItems,
      applications,
      messages,
    };
  }
}

@Controller('v1/home/directory')
export class DirectoryController {
  constructor(private readonly svc: DirectoryService) {}

  @Get()
  list(@Ctx() ctx: RequestContext) {
    return this.svc.list(ctx);
  }

  @Get(':id')
  detail(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.svc.detail(ctx, id);
  }
}
