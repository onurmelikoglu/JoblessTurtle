import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService, Tx } from './prisma.service';

export interface OutboxInput {
  workspaceId?: string | null;
  eventType: string;
  aggregateId: string;
  dedupKey: string;
  payload?: Record<string, unknown>;
  availableAt?: Date;
}

/**
 * Olaylar iş verisiyle aynı transaction içinde OutboxEvent olarak yazılır; worker'daki
 * dağıtıcı bunları kuyruğa aktarır. Kuyrukta en az bir kez işlenebileceği varsayılır.
 */
@Injectable()
export class OutboxService {
  constructor(private readonly prisma: PrismaService) {}

  async emit(input: OutboxInput, tx?: Tx) {
    const db = tx ?? this.prisma;
    try {
      await db.outboxEvent.create({
        data: {
          workspaceId: input.workspaceId ?? null,
          eventType: input.eventType,
          aggregateId: input.aggregateId,
          dedupKey: input.dedupKey,
          payload: (input.payload ?? {}) as Prisma.InputJsonValue,
          availableAt: input.availableAt ?? new Date(),
        },
      });
    } catch (e) {
      // Aynı dedupKey ikinci kez yazılırsa olay zaten kayıtlı: sessizce yut.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return;
      throw e;
    }
  }
}
