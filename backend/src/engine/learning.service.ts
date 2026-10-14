import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { errorMessage } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { LearningKind } from '../domain/learning';

export interface LearningRecord {
  workspaceId: string;
  kind: Exclude<LearningKind, 'send'>;
  companyId?: string | null;
  aiTaskId?: string | null;
  features: Record<string, unknown>;
  outcome: Record<string, unknown>;
}

/** Deneyim defterine sonucu hemen bilinen işleri yazar (gönderimler adres sicili üzerinden işlenir). */
@Injectable()
export class LearningService {
  private readonly logger = new Logger('Learning');

  constructor(private readonly prisma: PrismaService) {}

  /** Kayıt yardımcı veridir; yazılamaması ana akışı durdurmaz. */
  async record(event: LearningRecord) {
    try {
      const company = event.companyId ? await this.prisma.company.findUnique({ where: { id: event.companyId }, select: { catalogId: true } }) : null;
      await this.prisma.learningEvent.create({
        data: {
          workspaceId: event.workspaceId,
          kind: event.kind,
          companyId: event.companyId ?? null,
          catalogCompanyId: company?.catalogId ?? null,
          aiTaskId: event.aiTaskId ?? null,
          features: event.features as Prisma.InputJsonValue,
          outcome: event.outcome as Prisma.InputJsonValue,
          resolvedAt: new Date(),
        },
      });
    } catch (e) {
      this.logger.warn(`Deneyim kaydı yazılamadı (${event.kind}): ${errorMessage(e)}`);
    }
  }
}
