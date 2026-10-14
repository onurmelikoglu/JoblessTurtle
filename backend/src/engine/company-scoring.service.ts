import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { computeQ, DimScore, QDimension } from '../domain/scoring';

@Injectable()
export class CompanyScoringService {
  constructor(private readonly prisma: PrismaService) {}

  /** Kanıtlardan Q ve coverage'ı yeniden hesaplar; kullanıcı değerlendirmesi (override) korunur. */
  async recompute(companyId: string) {
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: companyId }, include: { evidence: true } });
    const stored = (company.qualityDims ?? {}) as Record<string, { override?: boolean; score?: DimScore; note?: string }>;
    const overrides: Partial<Record<QDimension, { score: DimScore; note?: string }>> = {};
    for (const [k, v] of Object.entries(stored)) {
      if (v?.override) overrides[k as QDimension] = { score: (v.score ?? null) as DimScore, note: v.note };
    }
    const r = computeQ(company.evidence, overrides);
    await this.prisma.company.update({
      where: { id: companyId },
      data: { qScore: r.coverage > 0 ? r.q : null, qCoverage: r.coverage, qualityDims: r.dims as any },
    });
    return r;
  }
}
