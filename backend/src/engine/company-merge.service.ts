import { Injectable, Logger } from '@nestjs/common';
import { Company, Prisma } from '@prisma/client';
import { AuditService } from '../common/audit.service';
import { AppError, notFound } from '../common/errors';
import { OutboxService } from '../common/outbox.service';
import { PrismaService, Tx } from '../common/prisma.service';
import { bestTwinFor, findTwins, TwinProfile, twinPairKey, TwinVerdict } from '../domain/company-twins';
import { isHiddenCompany } from '../domain/hidden-company';
import { SENDABLE_CONTACT_KINDS } from '../domain/contacts';

const MAX_MERGE_HOPS = 5;
const ACTIVE_JOB_STATES = ['open', 'unknown', 'stale'];
const dismissedKey = (workspaceId: string) => `twins:dismissed:${workspaceId}`;
const MERGE_TX_TIMEOUT_MS = 60_000;

export interface TwinSuggestion {
  a: { id: string; name: string };
  b: { id: string; name: string };
  verdict: NonNullable<TwinVerdict>;
}

/** Kullanıcının "farklı firmalar" dediği çiftler (twinPairKey). */
export async function dismissedTwinPairs(db: { keyValue: { findUnique: (args: { where: { key: string } }) => Promise<{ value: unknown } | null> } }, workspaceId: string): Promise<Set<string>> {
  const kv = await db.keyValue.findUnique({ where: { key: dismissedKey(workspaceId) } });
  return new Set(((kv?.value as { pairs?: string[] } | null)?.pairs ?? []).filter((p) => typeof p === 'string'));
}

/** Birleştirilmiş kaydın yönlendirdiği firma; zincir varsa sonuna kadar izlenir. */
export async function followMerged<T extends { mergedIntoId: string | null }>(db: { company: { findUnique: (args: { where: { id: string } }) => Promise<Company | null> } }, company: T | null): Promise<T | Company | null> {
  let current: T | Company | null = company;
  for (let hop = 0; current?.mergedIntoId && hop < MAX_MERGE_HOPS; hop++) current = await db.company.findUnique({ where: { id: current.mergedIntoId } });
  return current;
}

/**
 * Aynı firmanın kayıtlarını bulur ve birleştirir. Kalan kayda ilanlar, fırsatlar, adresler, ofisler, kanıtlar ve
 * başvurular taşınır; aynı ilan iki kayıtta varsa tek ilana iner. Kaldırılan kayıt silinmez, kalan kayda yönlendiren
 * gizli bir kayıt olur: ilan siteleri eski adı yeniden getirdiğinde yeni bir kopya açılmaz.
 */
@Injectable()
export class CompanyMergeService {
  private readonly logger = new Logger('CompanyMerge');

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
  ) {}

  async profiles(workspaceId: string): Promise<TwinProfile[]> {
    const companies = await this.prisma.company.findMany({
      where: { workspaceId, excluded: false, mergedIntoId: null },
      select: {
        id: true,
        name: true,
        canonicalDomain: true,
        website: true,
        jobs: { where: { status: { in: ACTIVE_JOB_STATES } }, select: { normalizedTitle: true, district: true, city: true, locationText: true } },
        contacts: { where: { suppressed: false }, select: { email: true } },
        offices: { select: { city: true, district: true } },
      },
    });
    return companies.map((c) => ({
      id: c.id,
      name: c.name,
      domains: [c.canonicalDomain, c.website],
      jobs: c.jobs.map((j) => ({ title: j.normalizedTitle, place: [j.district, j.city].filter(Boolean).join(' ') || j.locationText })),
      emailDomains: c.contacts.map((ct) => ct.email.split('@')[1] ?? '').filter(Boolean),
      officePlaces: c.offices.map((o) => [o.district, o.city].filter(Boolean).join(' ')).filter(Boolean),
    }));
  }

  private dismissed(workspaceId: string): Promise<Set<string>> {
    return dismissedTwinPairs(this.prisma, workspaceId);
  }

  /**
   * Henüz kaydedilmemiş firmanın kayıtlı (birleştirilmemiş, gizlenmemiş) firmalar arasındaki en olası ikizi. profiles
   * verilirse yeniden okunmaz (aynı turda birden çok firma soruluyorsa).
   */
  async similarTo(workspaceId: string, candidate: Omit<TwinProfile, 'id'>, profiles?: TwinProfile[]) {
    return bestTwinFor({ ...candidate, id: '' }, profiles ?? (await this.profiles(workspaceId)));
  }

  /** Olası ikizler; kullanıcının "farklı firmalar" dediği çiftler hariç. */
  async suggestions(workspaceId: string): Promise<TwinSuggestion[]> {
    const dismissed = await this.dismissed(workspaceId);
    return findTwins(await this.profiles(workspaceId))
      .filter((t) => !dismissed.has(twinPairKey(t.a.id, t.b.id)))
      .map((t) => ({ a: { id: t.a.id, name: t.a.name }, b: { id: t.b.id, name: t.b.name }, verdict: t.verdict }));
  }

  async dismiss(workspaceId: string, aId: string, bId: string) {
    const pairs = [...(await this.dismissed(workspaceId)), twinPairKey(aId, bId)];
    const value = { pairs } as Prisma.InputJsonValue;
    await this.prisma.keyValue.upsert({ where: { key: dismissedKey(workspaceId) }, create: { key: dismissedKey(workspaceId), value }, update: { value } });
  }

  /** Kesin aynı olan çiftler kendiliğinden birleştirilir; kullanıcıya hangilerinin birleştiği bildirilir. */
  async autoMerge(workspaceId: string) {
    const certain = (await this.suggestions(workspaceId)).filter((s) => s.verdict.level === 'certain');
    const gone = new Set<string>();
    const merged: string[] = [];
    for (const s of certain) {
      if (gone.has(s.a.id) || gone.has(s.b.id)) continue;
      const [keep, drop] = await this.ranked(s.a.id, s.b.id);
      try {
        await this.merge(workspaceId, keep, drop, { actorId: null, reasons: s.verdict.reasons });
        gone.add(drop);
        merged.push(`${s.a.name} = ${s.b.name}`);
      } catch (e) {
        this.logger.warn(`Firmalar birleştirilemedi (${s.a.id}, ${s.b.id}): ${(e as Error).message}`);
      }
    }
    if (merged.length) {
      await this.outbox.emit({
        workspaceId,
        eventType: 'notify',
        aggregateId: workspaceId,
        dedupKey: `companies-merged:${workspaceId}:${Date.now()}`,
        payload: { type: 'companies_merged', title: `${merged.length} çift kayıt birleştirildi`, body: merged.slice(0, 5).join(' · '), link: '/' },
      });
    }
    return { merged: merged.length };
  }

  /**
   * Adı gizli firmalar ("Gizli Firma", "Firma Adı Gizli"…) kaldırılır: başvurusu olmayan kayıt ilanları, fırsatları
   * ve gönderilmemiş taslaklarıyla silinir; başvurusu olan kayıt geçmiş bozulmasın diye yalnızca gizlenir.
   */
  async removeHiddenCompanies(workspaceId?: string) {
    const rows = await this.prisma.company.findMany({ where: { ...(workspaceId ? { workspaceId } : {}), mergedIntoId: null }, select: { id: true, name: true, excluded: true } });
    const hidden = rows.filter((c) => isHiddenCompany(c.name));
    let removed = 0;
    let excluded = 0;
    for (const c of hidden) {
      const attempts = await this.prisma.applicationAttempt.count({ where: { companyId: c.id } });
      if (attempts) {
        if (!c.excluded) {
          await this.prisma.company.update({ where: { id: c.id }, data: { excluded: true, excludedReason: 'Adı gizli firma' } });
          excluded++;
        }
        continue;
      }
      await this.prisma.$transaction([
        this.prisma.applicationDraft.deleteMany({ where: { companyId: c.id } }),
        this.prisma.researchBatchItem.deleteMany({ where: { companyId: c.id } }),
        this.prisma.company.delete({ where: { id: c.id } }),
      ]);
      removed++;
    }
    if (removed || excluded) this.logger.log(`Adı gizli firmalar kaldırıldı: ${removed} silindi, ${excluded} gizlendi`);
    return { removed, excluded };
  }

  /** Kalacak kayıt: başvurusu, adresi, ofisi ve ilanı çok olan; eşitse daha eski olan. */
  private async ranked(aId: string, bId: string): Promise<[string, string]> {
    const score = async (id: string) => {
      const [company, attempts, contacts, offices, jobs] = await Promise.all([
        this.prisma.company.findUniqueOrThrow({ where: { id }, select: { createdAt: true, canonicalDomain: true } }),
        this.prisma.applicationAttempt.count({ where: { companyId: id } }),
        this.prisma.contactPoint.count({ where: { companyId: id, suppressed: false, kind: { in: SENDABLE_CONTACT_KINDS } } }),
        this.prisma.office.count({ where: { companyId: id } }),
        this.prisma.job.count({ where: { companyId: id } }),
      ]);
      return { value: attempts * 10 + contacts * 3 + offices * 2 + jobs + (company.canonicalDomain ? 5 : 0), createdAt: company.createdAt.getTime() };
    };
    const [a, b] = await Promise.all([score(aId), score(bId)]);
    return a.value > b.value || (a.value === b.value && a.createdAt <= b.createdAt) ? [aId, bId] : [bId, aId];
  }

  async merge(workspaceId: string, keepId: string, dropId: string, opts: { actorId: string | null; reasons?: string[] }) {
    if (keepId === dropId) throw new AppError(422, 'SAME_COMPANY', 'Aynı firma kendisiyle birleştirilemez');
    const [keep, drop] = await Promise.all([
      this.prisma.company.findFirst({ where: { id: keepId, workspaceId } }),
      this.prisma.company.findFirst({ where: { id: dropId, workspaceId } }),
    ]);
    if (!keep || !drop) throw notFound('Firma');
    if (keep.mergedIntoId || drop.mergedIntoId) throw new AppError(409, 'ALREADY_MERGED', 'Firmalardan biri zaten başka bir kayıtla birleştirilmiş');
    await this.prisma.$transaction((tx) => this.moveAll(tx, keep, drop), { timeout: MERGE_TX_TIMEOUT_MS });
    await this.audit.log({ workspaceId, actorId: opts.actorId, action: 'company.merge', entityType: 'Company', entityId: keep.id, previous: { droppedId: drop.id, droppedName: drop.name }, next: { reasons: opts.reasons ?? ['Elle birleştirildi'] } });
    await this.outbox.emit({ workspaceId, eventType: 'evaluate.company', aggregateId: keep.id, dedupKey: `eval-company:${keep.id}:merge:${drop.id}`, payload: { companyId: keep.id } });
    return { keptId: keep.id, droppedId: drop.id };
  }

  private async moveAll(tx: Tx, keep: Company, drop: Company) {
    const byDrop = { companyId: drop.id };
    const toKeep = { companyId: keep.id };

    const keepContacts = new Map((await tx.contactPoint.findMany({ where: { companyId: keep.id }, select: { id: true, email: true } })).map((c) => [c.email, c.id]));
    for (const c of await tx.contactPoint.findMany({ where: byDrop, select: { id: true, email: true } })) {
      const existing = keepContacts.get(c.email);
      if (!existing) continue;
      await tx.applicationDraft.updateMany({ where: { contactId: c.id }, data: { contactId: existing } });
      await tx.contactPoint.delete({ where: { id: c.id } });
    }
    await tx.contactPoint.updateMany({ where: byDrop, data: toKeep });

    const keepItems = new Set((await tx.researchBatchItem.findMany({ where: { companyId: keep.id }, select: { batchId: true } })).map((i) => i.batchId));
    await tx.researchBatchItem.deleteMany({ where: { companyId: drop.id, batchId: { in: [...keepItems] } } });

    for (const model of ['office', 'companyEvidence', 'sourceConnector', 'autopilotAction', 'learningEvent', 'suppression', 'applicationDraft', 'applicationAttempt', 'researchBatchItem'] as const) {
      await (tx[model] as unknown as { updateMany: (args: object) => Promise<unknown> }).updateMany({ where: byDrop, data: toKeep });
    }

    const keepJobs = await tx.job.findMany({ where: { companyId: keep.id }, select: { id: true, normalizedTitle: true, district: true } });
    for (const job of await tx.job.findMany({ where: byDrop, select: { id: true, normalizedTitle: true, district: true } })) {
      const twin = keepJobs.find((k) => k.normalizedTitle === job.normalizedTitle && (k.district === job.district || !k.district || !job.district));
      if (!twin) {
        await tx.job.update({ where: { id: job.id }, data: toKeep });
        await tx.opportunity.updateMany({ where: { jobId: job.id }, data: toKeep });
        continue;
      }
      await tx.jobListing.updateMany({ where: { jobId: job.id }, data: { jobId: twin.id } });
      await tx.applicationDraft.updateMany({ where: { jobId: job.id }, data: { jobId: twin.id } });
      await tx.applicationAttempt.updateMany({ where: { jobId: job.id }, data: { jobId: twin.id } });
      await this.moveOpportunities(tx, { jobId: job.id }, (o) => ({ searchProfileId: o.searchProfileId, key: twin.id }), { jobId: twin.id, key: twin.id, companyId: keep.id });
      await tx.job.delete({ where: { id: job.id } });
    }

    await this.moveOpportunities(tx, { companyId: drop.id, jobId: null }, (o) => ({ searchProfileId: o.searchProfileId, key: `company:${keep.id}` }), { key: `company:${keep.id}`, companyId: keep.id });
    await tx.opportunity.updateMany({ where: byDrop, data: toKeep });

    const union = (a: string[], b: string[]) => [...new Set([...a, ...b])];
    const domain = keep.canonicalDomain ?? drop.canonicalDomain;
    await tx.company.update({ where: { id: drop.id }, data: { mergedIntoId: keep.id, excluded: true, excludedReason: `Birleştirildi: ${keep.name}`, canonicalDomain: null, catalogId: keep.catalogId ? drop.catalogId : null } });
    await tx.company.update({
      where: { id: keep.id },
      data: {
        canonicalDomain: domain,
        website: keep.website ?? drop.website,
        careersUrl: keep.careersUrl ?? drop.careersUrl,
        linkedinUrl: keep.linkedinUrl ?? drop.linkedinUrl,
        employeeRange: keep.employeeRange ?? drop.employeeRange,
        employeeCount: keep.employeeCount ?? drop.employeeCount,
        phone: keep.phone ?? drop.phone,
        workPolicy: keep.workPolicy ?? drop.workPolicy,
        description: keep.description ?? drop.description,
        groupName: keep.groupName ?? drop.groupName,
        legalName: keep.legalName ?? drop.legalName,
        applicationLanguage: keep.applicationLanguage ?? drop.applicationLanguage,
        catalogId: keep.catalogId ?? drop.catalogId,
        researchReport: (keep.researchReport ?? drop.researchReport ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        sectors: union(keep.sectors, drop.sectors),
        services: union(keep.services, drop.services),
        aliases: union(keep.aliases, [drop.name, ...drop.aliases]).filter((a) => a !== keep.name),
        watch: keep.watch || drop.watch,
      },
    });
  }

  /** Fırsatı kalan kayda taşır; kalan kayıtta aynı profil için aynı fırsat varsa taslaklar ona bağlanıp kopya silinir. */
  private async moveOpportunities(tx: Tx, where: Prisma.OpportunityWhereInput, targetOf: (o: { searchProfileId: string }) => { searchProfileId: string; key: string }, data: Prisma.OpportunityUncheckedUpdateManyInput) {
    for (const o of await tx.opportunity.findMany({ where, select: { id: true, searchProfileId: true } })) {
      const target = targetOf(o);
      const existing = await tx.opportunity.findUnique({ where: { searchProfileId_key: target }, select: { id: true } });
      if (existing && existing.id !== o.id) {
        await tx.applicationDraft.updateMany({ where: { opportunityId: o.id }, data: { opportunityId: existing.id } });
        await tx.opportunity.delete({ where: { id: o.id } });
      } else {
        await tx.opportunity.update({ where: { id: o.id }, data });
      }
    }
  }
}
