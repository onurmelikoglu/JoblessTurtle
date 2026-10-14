import { Body, Controller, Delete, Get, Injectable, Module, Param, Patch, Post, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { randomUUID } from 'crypto';
import type { Response } from 'express';
import { z } from 'zod';
import { AuditService } from '../../common/audit.service';
import { OutboxService } from '../../common/outbox.service';
import { Ctx, RequestContext } from '../../common/auth';
import { sha256 } from '../../common/crypto';
import { env } from '../../common/env';
import { AppError, notFound } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { StorageService } from '../../common/storage.service';
import { ZodPipe } from '../../common/zod.pipe';
import { scanFile } from '../../domain/file-scan';
import { DraftingService } from '../../engine/drafting.service';

const uploadSchema = z.object({
  candidateId: z.string(),
  type: z.enum(['cv', 'portfolio', 'cover_letter', 'other']),
  language: z.string().max(5).default('tr'),
  label: z.string().max(120).optional(),
});
const patchSchema = z.object({ label: z.string().max(120).optional(), archived: z.boolean().optional() });
const migrateSchema = z.object({ fromDocumentId: z.string(), toDocumentId: z.string() });

@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly drafting: DraftingService,
    private readonly outbox: OutboxService,
  ) {}

  async list(ctx: RequestContext, candidateId?: string) {
    return this.prisma.documentVersion.findMany({
      where: { workspaceId: ctx.workspaceId, ...(candidateId ? { candidateId } : {}) },
      orderBy: [{ candidateId: 'asc' }, { type: 'asc' }, { createdAt: 'desc' }],
    });
  }

  /** Belge kaydı immutable sürüm taşır; yeni yükleme kuyruktaki eski sürümü sessizce değiştirmez. */
  async upload(ctx: RequestContext, input: z.infer<typeof uploadSchema>, file: Express.Multer.File | undefined) {
    if (!file) throw new AppError(400, 'FILE_REQUIRED', 'Dosya seçin');
    await this.scope.candidate(ctx, input.candidateId);
    const fileName = Buffer.from(file.originalname, 'latin1').toString('utf8').replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 120);
    const scan = scanFile(fileName, file.buffer, env().MAX_UPLOAD_MB * 1024 * 1024);
    if (!scan.ok && !scan.mime) throw new AppError(422, 'FILE_REJECTED', scan.reason ?? 'Dosya reddedildi');
    const prev = await this.prisma.documentVersion.count({ where: { candidateId: input.candidateId, type: input.type, language: input.language } });
    const objectKey = `candidates/${input.candidateId}/${randomUUID()}`;
    if (scan.ok) await this.storage.put(objectKey, file.buffer);
    const doc = await this.prisma.documentVersion.create({
      data: {
        workspaceId: ctx.workspaceId,
        candidateId: input.candidateId,
        type: input.type,
        language: input.language,
        label: input.label ?? `${input.type.toUpperCase()} ${input.language.toUpperCase()} v${prev + 1}`,
        fileName,
        objectKey,
        sha256: sha256(file.buffer),
        mime: scan.mime!,
        size: file.size,
        scanState: scan.ok ? 'clean' : 'rejected',
        scanReason: scan.reason ?? null,
        revision: prev + 1,
      },
    });
    await this.audit.log({ workspaceId: ctx.workspaceId, actorId: ctx.userId, action: 'document.upload', entityType: 'DocumentVersion', entityId: doc.id, next: { sha256: doc.sha256, scanState: doc.scanState } });
    if (!scan.ok) throw new AppError(422, 'FILE_REJECTED', scan.reason ?? 'Dosya taramadan geçmedi', { documentId: doc.id });
    if (doc.type === 'cv') await this.outbox.emit({ workspaceId: ctx.workspaceId, eventType: 'candidate.cv_uploaded', aggregateId: input.candidateId, dedupKey: `cv-facts:${doc.id}` });
    return doc;
  }

  async download(ctx: RequestContext, id: string, res: Response) {
    const doc = await this.prisma.documentVersion.findFirst({ where: { id, workspaceId: ctx.workspaceId } });
    if (!doc) throw notFound('Belge');
    if (doc.scanState !== 'clean') throw new AppError(422, 'DOCUMENT_NOT_READY', 'Taramadan geçmemiş belge indirilemez');
    const data = await this.storage.get(doc.objectKey);
    res.setHeader('Content-Type', doc.mime);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(doc.fileName)}`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(data);
  }

  async update(ctx: RequestContext, id: string, input: z.infer<typeof patchSchema>) {
    const doc = await this.prisma.documentVersion.findFirst({ where: { id, workspaceId: ctx.workspaceId } });
    if (!doc) throw notFound('Belge');
    return this.prisma.documentVersion.update({ where: { id }, data: input });
  }

  async remove(ctx: RequestContext, id: string) {
    const doc = await this.prisma.documentVersion.findFirst({ where: { id, workspaceId: ctx.workspaceId } });
    if (!doc) throw notFound('Belge');
    const used = await this.prisma.applicationAttempt.count({ where: { documentHashes: { array_contains: [{ id }] } } });
    if (used > 0) {
      // Gönderim geçmişinde kullanılmış sürüm kanıt olarak saklanır; yalnızca arşivlenir.
      await this.prisma.documentVersion.update({ where: { id }, data: { archived: true } });
      return { archived: true };
    }
    await this.storage.delete(doc.objectKey);
    await this.prisma.documentVersion.delete({ where: { id } });
    await this.audit.log({ workspaceId: ctx.workspaceId, actorId: ctx.userId, action: 'document.delete', entityType: 'DocumentVersion', entityId: id });
    return { deleted: true };
  }

  /** Bekleyen taslakları yeni belge sürümüne geçirir: her taslak için yeni sürüm oluşturulur (açık onay). */
  async migrateDrafts(ctx: RequestContext, input: z.infer<typeof migrateSchema>) {
    const [from, to] = await Promise.all([
      this.prisma.documentVersion.findFirst({ where: { id: input.fromDocumentId, workspaceId: ctx.workspaceId } }),
      this.prisma.documentVersion.findFirst({ where: { id: input.toDocumentId, workspaceId: ctx.workspaceId } }),
    ]);
    if (!from || !to) throw notFound('Belge');
    if (from.candidateId !== to.candidateId) throw new AppError(422, 'DOCUMENT_NOT_OWNED', 'Belgeler aynı adaya ait olmalı');
    if (to.scanState !== 'clean') throw new AppError(422, 'DOCUMENT_NOT_READY', 'Yeni belge taramadan geçmedi');
    const drafts = await this.prisma.applicationDraft.findMany({ where: { workspaceId: ctx.workspaceId, candidateId: from.candidateId, status: { in: ['draft', 'needs_review'] } } });
    let migrated = 0;
    for (const d of drafts) {
      const cur = await this.drafting.currentRevision(d.id);
      if (!cur || !cur.documentIds.includes(from.id)) continue;
      await this.drafting.addRevision(
        d,
        { toEmail: cur.toEmail, subject: cur.subject, body: cur.body, documentIds: cur.documentIds.map((x) => (x === from.id ? to.id : x)), links: cur.links },
        { createdById: ctx.userId, generator: 'user' },
      );
      migrated++;
    }
    // Politikalar da yeni sürüme geçirilir; aktif politikalar yeniden etkinleştirme ister (yeni sürüm).
    const policies = await this.prisma.automationPolicy.findMany({ where: { workspaceId: ctx.workspaceId, documentIds: { has: from.id } } });
    for (const p of policies) {
      await this.prisma.automationPolicy.update({ where: { id: p.id }, data: { documentIds: p.documentIds.map((x) => (x === from.id ? to.id : x)), active: false, version: { increment: 1 }, disabledAt: new Date() } });
    }
    await this.audit.log({ workspaceId: ctx.workspaceId, actorId: ctx.userId, action: 'document.migrate', entityType: 'DocumentVersion', entityId: to.id, next: { from: from.id, migrated, policies: policies.length } });
    return { migratedDrafts: migrated, policiesNeedReactivation: policies.length };
  }
}

@Controller('v1')
export class DocumentsController {
  constructor(private readonly svc: DocumentsService) {}

  @Get('documents')
  list(@Ctx() ctx: RequestContext, @Query('candidateId') candidateId?: string) {
    return this.svc.list(ctx, candidateId);
  }

  @Post('documents')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: env().MAX_UPLOAD_MB * 1024 * 1024 + 1 } }))
  upload(@Ctx() ctx: RequestContext, @Body(new ZodPipe(uploadSchema)) body: z.infer<typeof uploadSchema>, @UploadedFile() file?: Express.Multer.File) {
    return this.svc.upload(ctx, body, file);
  }

  @Get('documents/:id/download')
  download(@Ctx() ctx: RequestContext, @Param('id') id: string, @Res() res: Response) {
    return this.svc.download(ctx, id, res);
  }

  @Patch('documents/:id')
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new ZodPipe(patchSchema)) body: z.infer<typeof patchSchema>) {
    return this.svc.update(ctx, id, body);
  }

  @Delete('documents/:id')
  remove(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.svc.remove(ctx, id);
  }

  @Post('documents/migrate-drafts')
  migrate(@Ctx() ctx: RequestContext, @Body(new ZodPipe(migrateSchema)) body: z.infer<typeof migrateSchema>) {
    return this.svc.migrateDrafts(ctx, body);
  }
}

@Module({ controllers: [DocumentsController], providers: [DocumentsService] })
export class DocumentsModule {}
