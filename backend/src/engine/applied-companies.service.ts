import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { CompanyIdentity, CompanyIdentityIndex } from '../domain/company-identity';

/** Gönderilemeyip kullanıcının listeden kaldırdığı başvurular firmayı "başvurulmuş" yapmaz. */
const DROPPED_STATES = ['blocked', 'failed_confirmed'];

export interface AppliedCompany extends CompanyIdentity {
  attemptId: string;
  appliedAt: Date;
}

export interface AppliedIndex {
  /** Firma (ya da aynı firmanın başka adla açılmış kaydı) Başvurularım'da mı? */
  match(company: CompanyIdentity): AppliedCompany | null;
  readonly size: number;
}

/**
 * Başvurularım'da görünen firmalar: iptal edilmemiş her başvuru, gönderilemeyip listeden kaldırılanlar hariç. Aynı
 * firmanın farklı ad ya da alan adıyla açılmış kayıtları da başvurulmuş sayılır; Firmalar listesine, otomatik taslağa
 * ve otomatik başvuruya girmez, yeni ilanı yalnızca bildirim olur.
 */
@Injectable()
export class AppliedCompaniesService {
  constructor(private readonly prisma: PrismaService) {}

  async index(workspaceId: string): Promise<AppliedIndex> {
    const attempts = await this.prisma.applicationAttempt.findMany({
      where: { workspaceId, state: { not: 'cancelled' }, NOT: { state: { in: DROPPED_STATES }, hiddenAt: { not: null } } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, createdAt: true, companyId: true },
    });
    const latest = new Map<string, { attemptId: string; appliedAt: Date }>();
    for (const a of attempts) if (!latest.has(a.companyId)) latest.set(a.companyId, { attemptId: a.id, appliedAt: a.createdAt });
    const companies = await this.prisma.company.findMany({ where: { id: { in: [...latest.keys()] } }, select: { id: true, name: true, canonicalDomain: true, website: true } });
    return new CompanyIdentityIndex(companies.map((c) => ({ ...c, ...latest.get(c.id)! })));
  }

  async matchOf(workspaceId: string, companyId: string): Promise<AppliedCompany | null> {
    const company = await this.prisma.company.findFirst({ where: { id: companyId, workspaceId }, select: { id: true, name: true, canonicalDomain: true, website: true } });
    return company ? (await this.index(workspaceId)).match(company) : null;
  }
}
