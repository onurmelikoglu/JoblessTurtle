import { Injectable } from '@nestjs/common';
import { RequestContext } from './auth';
import { notFound } from './errors';
import { PrismaService } from './prisma.service';

/**
 * Sunucu tarafı sahiplik kontrolleri. Başka workspace'e ait kayıt "bulunamadı" olarak döner;
 * böylece kayıt varlığı da sızdırılmaz.
 */
@Injectable()
export class ScopeService {
  constructor(private readonly prisma: PrismaService) {}

  async candidate(ctx: RequestContext, id: string) {
    const c = await this.prisma.candidateProfile.findFirst({ where: { id, workspaceId: ctx.workspaceId } });
    if (!c) throw notFound('Aday profili');
    return c;
  }

  async searchProfile(ctx: RequestContext, id: string) {
    const p = await this.prisma.searchProfile.findFirst({ where: { id, workspaceId: ctx.workspaceId } });
    if (!p) throw notFound('Arama profili');
    return p;
  }

  async company(ctx: RequestContext, id: string) {
    const c = await this.prisma.company.findFirst({ where: { id, workspaceId: ctx.workspaceId } });
    if (!c) throw notFound('Firma');
    return c;
  }

  async mailAccount(ctx: RequestContext, id: string) {
    const a = await this.prisma.mailAccount.findFirst({ where: { id, workspaceId: ctx.workspaceId } });
    if (!a) throw notFound('Mail hesabı');
    return a;
  }

  async draft(ctx: RequestContext, id: string) {
    const d = await this.prisma.applicationDraft.findFirst({ where: { id, workspaceId: ctx.workspaceId } });
    if (!d) throw notFound('Taslak');
    return d;
  }

  async source(ctx: RequestContext, id: string) {
    const s = await this.prisma.sourceConnector.findFirst({ where: { id, workspaceId: ctx.workspaceId } });
    if (!s) throw notFound('Kaynak');
    return s;
  }

  async policy(ctx: RequestContext, id: string) {
    const p = await this.prisma.automationPolicy.findFirst({ where: { id, workspaceId: ctx.workspaceId } });
    if (!p) throw notFound('Politika');
    return p;
  }

  async job(ctx: RequestContext, id: string) {
    const j = await this.prisma.job.findFirst({ where: { id, workspaceId: ctx.workspaceId } });
    if (!j) throw notFound('İlan');
    return j;
  }

  async attempt(ctx: RequestContext, id: string) {
    const a = await this.prisma.applicationAttempt.findFirst({ where: { id, workspaceId: ctx.workspaceId } });
    if (!a) throw notFound('Başvuru');
    return a;
  }
}
