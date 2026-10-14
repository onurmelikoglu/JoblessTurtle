import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService, Tx } from './prisma.service';

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async log(
    e: {
      workspaceId?: string | null;
      actorId?: string | null;
      actorType?: 'user' | 'system' | 'worker';
      action: string;
      entityType: string;
      entityId?: string | null;
      reason?: string | null;
      previous?: unknown;
      next?: unknown;
    },
    tx?: Tx,
  ) {
    const db = tx ?? this.prisma;
    await db.auditEvent.create({
      data: {
        workspaceId: e.workspaceId ?? null,
        actorId: e.actorId ?? null,
        actorType: e.actorType ?? 'user',
        action: e.action,
        entityType: e.entityType,
        entityId: e.entityId ?? null,
        reason: e.reason ?? null,
        previous: (e.previous ?? undefined) as Prisma.InputJsonValue | undefined,
        next: (e.next ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
  }
}
