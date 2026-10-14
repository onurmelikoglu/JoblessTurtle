import { Body, Controller, Get, Injectable, Module, Param, Post, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import ExcelJS from 'exceljs';
import type { Response } from 'express';
import { z } from 'zod';
import { AuditService } from '../../common/audit.service';
import { Ctx, RequestContext } from '../../common/auth';
import { hashObject } from '../../common/crypto';
import { AppError, notFound } from '../../common/errors';
import { OutboxService } from '../../common/outbox.service';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { StorageService } from '../../common/storage.service';
import { istanbulDay } from '../../common/time';
import { ZodPipe } from '../../common/zod.pipe';
import { activeKeyFor } from '../../domain/attempt-state';
import { classifyPublishedEmail, extractEmails, isValidEmail } from '../../domain/contacts';
import { escapeCell, toCsv } from '../../domain/csv';
import { detectLocation } from '../../domain/geo';
import { fold, normalizeCompanyName, normalizeDomain } from '../../domain/text';
import { normalizeTitle } from '../../domain/titles';

export const COMPANY_FIELDS = ['name', 'website', 'district', 'address', 'sector', 'services', 'email', 'notes', 'status', 'jobTitle', 'jobUrl', 'jobDate', 'source', 'customers', 'works', 'priority'] as const;
export const DETAIL_FIELDS = ['companyName', 'detail', 'customers', 'works', 'url', 'date'] as const;

const FIELD_HINTS: Record<string, RegExp> = {
  name: /^(firma|firma adi|sirket|sirket adi|ajans|ajans adi|company|company name|marka|kurum)$/,
  website: /(web|site|url|domain|internet)/,
  district: /(ilce|district|semt|bolge|konum|lokasyon|location)/,
  address: /(adres|address)/,
  sector: /(sektor|sector|kategori|tur|type|alan)/,
  services: /(hizmet|services|uzmanlik)/,
  email: /(e ?posta|mail|email|iletisim)/,
  notes: /(not|notes|aciklama|yorum|comment)/,
  status: /(durum|status|basvuru)/,
  jobTitle: /(pozisyon|ilan|unvan|rol|title|position)/,
  jobUrl: /(ilan link|ilan url|job url|posting|basvuru link)/,
  jobDate: /(tarih|date)/,
  source: /(kaynak|source|platform)/,
  customers: /(musteri|clients|customers|markalar|referans)/,
  works: /(isler|projeler|works|kampanya|portfolio|portfoy)/,
  priority: /(oncelik|priority|puan|skor|score)/,
  companyName: /^(firma|firma adi|sirket|ajans|company|marka)$/,
  detail: /(detay|rapor|analiz|ozet|detail|report|summary|degerlendirme)/,
  url: /(url|link|kaynak)/,
  date: /(tarih|date)/,
};

const SENT_STATUS = /(basvuruldu|basvuru yapildi|gonderildi|mail atildi|iletildi|applied|sent|cv gonderildi)/;

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    const o = v as any;
    if (o.text) return String(o.text);
    if (o.hyperlink) return String(o.hyperlink);
    if (o.richText) return o.richText.map((r: any) => r.text).join('');
    if (o.result !== undefined) return String(o.result);
    return '';
  }
  return String(v).trim();
}

export function suggestMapping(headers: string[], fields: readonly string[]) {
  const mapping: Record<string, number | null> = {};
  const used = new Set<number>();
  for (const f of fields) {
    const re = FIELD_HINTS[f];
    const idx = headers.findIndex((h, i) => !used.has(i) && re?.test(fold(h)));
    mapping[f] = idx >= 0 ? idx : null;
    if (idx >= 0) used.add(idx);
  }
  return mapping;
}

interface SheetInfo {
  name: string;
  headers: string[];
  headerRow: number;
  rowCount: number;
  sample: string[][];
  suggestedRole: 'companies' | 'details' | 'skip';
  suggestedMapping: Record<string, number | null>;
}

async function readWorkbook(buf: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as any);
  return wb;
}

function sheetRows(ws: ExcelJS.Worksheet): string[][] {
  const rows: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const values = (row.values as ExcelJS.CellValue[]).slice(1).map(cellText);
    if (values.some((v) => v)) rows.push(values);
  });
  return rows;
}

function analyzeSheet(ws: ExcelJS.Worksheet): SheetInfo {
  const rows = sheetRows(ws);
  const headerIdx = Math.max(0, rows.findIndex((r) => r.filter(Boolean).length >= 2));
  const headers = (rows[headerIdx] ?? []).map((h) => h || '');
  const data = rows.slice(headerIdx + 1);
  const companyMap = suggestMapping(headers, COMPANY_FIELDS);
  const detailMap = suggestMapping(headers, DETAIL_FIELDS);
  let role: SheetInfo['suggestedRole'] = 'skip';
  if (detailMap.detail !== null && detailMap.companyName !== null && companyMap.website === null) role = 'details';
  else if (companyMap.name !== null) role = 'companies';
  return {
    name: ws.name,
    headers,
    headerRow: headerIdx,
    rowCount: data.length,
    sample: data.slice(0, 5),
    suggestedRole: role,
    suggestedMapping: role === 'details' ? detailMap : companyMap,
  };
}

const commitSchema = z.object({
  candidateId: z.string().optional(),
  dryRun: z.boolean().default(false),
  sheets: z.array(
    z.object({
      name: z.string(),
      role: z.enum(['companies', 'details', 'skip']),
      mapping: z.record(z.number().int().min(0).nullable()),
    }),
  ),
});

@Injectable()
export class ImportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async preview(ctx: RequestContext, file?: Express.Multer.File) {
    if (!file) throw new AppError(400, 'FILE_REQUIRED', 'Excel dosyası seçin');
    if (!/\.xlsx$/i.test(file.originalname) || file.buffer[0] !== 0x50) throw new AppError(422, 'FILE_REJECTED', 'Yalnızca .xlsx dosyaları desteklenir');
    let wb: ExcelJS.Workbook;
    try {
      wb = await readWorkbook(file.buffer);
    } catch {
      throw new AppError(422, 'FILE_REJECTED', 'Excel dosyası okunamadı');
    }
    const sheets = wb.worksheets.map(analyzeSheet);
    const objectKey = `imports/${ctx.workspaceId}/${randomUUID()}.xlsx`;
    await this.storage.put(objectKey, file.buffer);
    const job = await this.prisma.importJob.create({
      data: { workspaceId: ctx.workspaceId, fileName: file.originalname, objectKey, sheets: sheets as unknown as Prisma.InputJsonValue, createdById: ctx.userId },
    });
    return { importId: job.id, fileName: job.fileName, sheets, companyFields: COMPANY_FIELDS, detailFields: DETAIL_FIELDS };
  }

  /**
   * İçe alma: firma ve ilan kayıtları kaynağıyla taşınır; tarihsiz/teyit gerektiren ilanlar open yapılmaz.
   * Detay satırları mevcut firmalara bağlanır (tekrar firma sayılmaz). Geçmiş gönderim kanıtı tekrar engeline dahil edilir.
   */
  async commit(ctx: RequestContext, importId: string, input: z.infer<typeof commitSchema>) {
    const job = await this.prisma.importJob.findFirst({ where: { id: importId, workspaceId: ctx.workspaceId } });
    if (!job) throw notFound('İçe aktarma');
    if (job.state === 'imported' && !input.dryRun) throw new AppError(409, 'ALREADY_IMPORTED', 'Bu dosya zaten içe alındı');
    const candidate = input.candidateId
      ? await this.scope.candidate(ctx, input.candidateId)
      : await this.prisma.candidateProfile.findFirst({ where: { workspaceId: ctx.workspaceId }, orderBy: { createdAt: 'asc' } });
    const wb = await readWorkbook(await this.storage.get(job.objectKey));
    const stats = { companiesCreated: 0, companiesMatched: 0, duplicatesInFile: 0, anonymous: 0, detailsLinked: 0, detailsUnmatched: 0, contactsCreated: 0, jobsRecorded: 0, applicationsRecorded: 0, rowsSkipped: 0, unmatchedDetails: [] as string[] };
    const seen = new Map<string, string>(); // anahtar → firma id (dosya içi tekrar)
    let anonCounter = 0;

    const run = async (tx: Prisma.TransactionClient) => {
      let manualSource = await tx.sourceConnector.findFirst({ where: { workspaceId: ctx.workspaceId, kind: 'manual', companyId: null } });
      const ordered = [...input.sheets].sort((a, b) => (a.role === 'companies' ? -1 : 1) - (b.role === 'companies' ? -1 : 1));
      for (const sheetCfg of ordered) {
        if (sheetCfg.role === 'skip') continue;
        const ws = wb.getWorksheet(sheetCfg.name);
        if (!ws) continue;
        const info = analyzeSheet(ws);
        const rows = sheetRows(ws).slice(info.headerRow + 1);
        const get = (row: string[], f: string) => {
          const idx = sheetCfg.mapping[f];
          return idx === null || idx === undefined ? '' : (row[idx] ?? '').trim();
        };
        for (const [i, row] of rows.entries()) {
          const rowRef = `${job.fileName}#${sheetCfg.name}:${info.headerRow + i + 2}`;
          if (sheetCfg.role === 'companies') {
            let name = get(row, 'name');
            const website = get(row, 'website');
            const jobTitle = get(row, 'jobTitle');
            if (!name && !website) {
              if (!jobTitle) {
                stats.rowsSkipped++;
                continue;
              }
              anonCounter++;
              stats.anonymous++;
              name = `Anonim fırsat ${anonCounter}`;
            }
            const domain = normalizeDomain(website);
            const normalizedName = normalizeCompanyName(name || domain || '');
            const key = domain ?? normalizedName;
            if (seen.has(key)) {
              stats.duplicatesInFile++;
              continue;
            }
            let company = await tx.company.findFirst({ where: { workspaceId: ctx.workspaceId, OR: [...(domain ? [{ canonicalDomain: domain }] : []), { normalizedName }] } });
            const notes = [get(row, 'notes'), get(row, 'status') ? `Durum: ${get(row, 'status')}` : '', get(row, 'priority') ? `Öncelik: ${get(row, 'priority')}` : '', get(row, 'source') ? `Kaynak: ${get(row, 'source')}` : '']
              .filter(Boolean)
              .join('\n');
            if (company) stats.companiesMatched++;
            else {
              stats.companiesCreated++;
              if (!input.dryRun) {
                company = await tx.company.create({
                  data: {
                    workspaceId: ctx.workspaceId,
                    name: name || domain!,
                    normalizedName,
                    canonicalDomain: domain,
                    website: domain ? `https://${domain}` : null,
                    sectors: get(row, 'sector') ? get(row, 'sector').split(/[,;/]/).map((s) => s.trim()).filter(Boolean) : [],
                    services: get(row, 'services') ? get(row, 'services').split(/[,;]/).map((s) => s.trim()).filter(Boolean) : [],
                    notes: notes || null,
                    origin: 'excel',
                    importRef: rowRef,
                  },
                });
              }
            }
            seen.set(key, company?.id ?? key);
            seen.set(normalizedName, company?.id ?? key);
            if (input.dryRun || !company) continue;
            if (notes && company.origin !== 'excel') await tx.company.update({ where: { id: company.id }, data: { notes: [company.notes, `Excel (${rowRef}):\n${notes}`].filter(Boolean).join('\n\n') } });
            const districtText = `${get(row, 'district')} ${get(row, 'address')}`.trim();
            if (districtText && (await tx.office.count({ where: { companyId: company.id } })) === 0) {
              const loc = detectLocation(districtText);
              await tx.office.create({ data: { companyId: company.id, kind: 'hq', address: get(row, 'address') || null, district: loc.district ?? (get(row, 'district') || null), city: loc.city ?? 'İstanbul', locationConfidence: loc.district ? 'medium' : 'low', label: 'Excel' } });
            }
            for (const email of extractEmails(get(row, 'email'))) {
              if (!isValidEmail(email)) continue;
              const cls = classifyPublishedEmail(email);
              const exists = await tx.contactPoint.findUnique({ where: { companyId_email: { companyId: company.id, email } } });
              if (!exists) {
                // İçe alınan adres doğrulanmış sayılmaz; kullanıcı onaylayana kadar otomatik gönderime girmez.
                await tx.contactPoint.create({ data: { workspaceId: ctx.workspaceId, companyId: company.id, email, kind: cls.kind, purpose: cls.note ?? 'Excel başlangıç verisi', sourceUrl: rowRef, confidence: 'low', ownershipEvidence: 'Kullanıcının Excel listesi' } });
                stats.contactsCreated++;
              }
            }
            const customers = get(row, 'customers');
            if (customers) {
              for (const cname of customers.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean).slice(0, 15)) {
                await tx.companyEvidence.create({ data: { workspaceId: ctx.workspaceId, companyId: company.id, dimension: 'customer', customerName: cname, scope: 'unknown', claimType: 'logo_wall', title: `Müşteri (Excel): ${cname}`, confidence: 'low', createdBy: 'import', url: null } });
              }
            }
            if (get(row, 'works')) {
              await tx.companyEvidence.create({ data: { workspaceId: ctx.workspaceId, companyId: company.id, dimension: 'campaign', scope: 'unknown', claimType: 'other', title: 'İşler (Excel)', summary: get(row, 'works').slice(0, 2000), confidence: 'low', createdBy: 'import' } });
            }
            if (jobTitle) {
              if (!manualSource) {
                manualSource = await tx.sourceConnector.create({ data: { workspaceId: ctx.workspaceId, kind: 'manual', name: 'Manuel kayıt', accessMode: 'manual', capabilities: ['manual_record'], isOfficial: false, health: 'healthy', minIntervalMinutes: 0, intervalMinutes: 0 } });
              }
              const externalId = hashObject({ rowRef, jobTitle }).slice(0, 24);
              const canonicalKey = `import:${company.id}:${normalizeTitle(jobTitle)}`;
              const j = await tx.job.upsert({
                where: { workspaceId_canonicalKey: { workspaceId: ctx.workspaceId, canonicalKey } },
                create: {
                  workspaceId: ctx.workspaceId,
                  companyId: company.id,
                  canonicalKey,
                  title: jobTitle,
                  normalizedTitle: normalizeTitle(jobTitle),
                  // Tarihsiz veya teyit gerektiren ilan "open" yapılmaz.
                  status: 'unknown',
                  statusReason: 'excel_import_needs_confirmation',
                  applyUrl: get(row, 'jobUrl') || null,
                  channel: 'unknown',
                  firstSeenAt: get(row, 'jobDate') && !isNaN(Date.parse(get(row, 'jobDate'))) ? new Date(get(row, 'jobDate')) : new Date(),
                },
                update: {},
              });
              await tx.jobListing.upsert({
                where: { sourceId_externalId: { sourceId: manualSource.id, externalId } },
                create: { workspaceId: ctx.workspaceId, jobId: j.id, sourceId: manualSource.id, externalId, title: jobTitle, canonicalUrl: get(row, 'jobUrl') || null, isOfficial: false, status: 'unknown', statusReason: 'excel_import' },
                update: {},
              });
              stats.jobsRecorded++;
            }
            if (candidate && SENT_STATUS.test(fold(get(row, 'status')))) {
              const draft = await tx.applicationDraft.create({
                data: { workspaceId: ctx.workspaceId, candidateId: candidate.id, companyId: company.id, intentType: 'general_intent', status: 'sent', origin: 'manual', currentRevision: 1, createdById: ctx.userId },
              });
              const body = `Excel'den içe alınan geçmiş başvuru kaydı.\n${notes}`;
              const hash = hashObject({ rowRef });
              await tx.draftRevision.create({ data: { draftId: draft.id, revision: 1, subject: 'Geçmiş başvuru (Excel)', body, hash, generator: 'import' } });
              const month = istanbulDay().slice(0, 7);
              await tx.applicationAttempt.create({
                data: {
                  workspaceId: ctx.workspaceId,
                  candidateId: candidate.id,
                  draftId: draft.id,
                  draftRevision: 1,
                  draftHash: hash,
                  companyId: company.id,
                  intentType: 'general_intent',
                  sendMode: 'import',
                  idempotencyKey: `import:${hash}`,
                  requestHash: hash,
                  activeKey: activeKeyFor(candidate.id, `company:${company.id}:${month}`, 'general_intent'),
                  state: 'outcome_recorded',
                  outcome: 'other',
                  notes: `Excel: ${get(row, 'status')}`,
                  createdById: ctx.userId,
                },
              });
              stats.applicationsRecorded++;
            }
          } else {
            const ref = get(row, 'companyName');
            const detail = get(row, 'detail');
            if (!ref || !detail) {
              stats.rowsSkipped++;
              continue;
            }
            const n = normalizeCompanyName(ref);
            let company = await tx.company.findFirst({ where: { workspaceId: ctx.workspaceId, normalizedName: n } });
            if (!company) {
              const candidates = await tx.company.findMany({ where: { workspaceId: ctx.workspaceId }, select: { id: true, normalizedName: true, name: true } });
              const hit = candidates.find((c) => c.normalizedName && (c.normalizedName.includes(n) || n.includes(c.normalizedName)));
              company = hit ? await tx.company.findUnique({ where: { id: hit.id } }) : null;
            }
            if (!company && input.dryRun && seen.has(n)) {
              stats.detailsLinked++;
              continue;
            }
            if (!company) {
              stats.detailsUnmatched++;
              stats.unmatchedDetails.push(ref);
              continue;
            }
            stats.detailsLinked++;
            if (input.dryRun) continue;
            await tx.companyEvidence.create({
              data: {
                workspaceId: ctx.workspaceId,
                companyId: company.id,
                dimension: 'service_fit',
                scope: 'unknown',
                claimType: 'other',
                title: `Detay rapor (Excel ${sheetCfg.name})`,
                summary: detail.slice(0, 4000),
                url: get(row, 'url') || null,
                evidenceDate: get(row, 'date') && !isNaN(Date.parse(get(row, 'date'))) ? new Date(get(row, 'date')) : null,
                confidence: 'low',
                createdBy: 'import',
                accepted: false,
              },
            });
            const report = (company.researchReport ?? {}) as any;
            await tx.company.update({
              where: { id: company.id },
              data: { researchReport: { ...report, importedSummary: detail.slice(0, 4000), importedFrom: rowRef } as Prisma.InputJsonValue },
            });
            for (const cname of get(row, 'customers').split(/[,;\n]/).map((s) => s.trim()).filter(Boolean).slice(0, 15)) {
              await tx.companyEvidence.create({ data: { workspaceId: ctx.workspaceId, companyId: company.id, dimension: 'customer', customerName: cname, scope: 'unknown', claimType: 'other', title: `Müşteri (detay rapor): ${cname}`, confidence: 'low', createdBy: 'import', accepted: false } });
            }
          }
        }
      }
    };

    if (input.dryRun) {
      // Önizleme: yazma yapmadan sayılar.
      await run(this.prisma as unknown as Prisma.TransactionClient);
      return { dryRun: true, stats };
    }
    await this.prisma.$transaction(run, { timeout: 120_000, maxWait: 10_000 });
    await this.prisma.importJob.update({ where: { id: importId }, data: { state: 'imported', mapping: input.sheets as unknown as Prisma.InputJsonValue, stats: stats as unknown as Prisma.InputJsonValue } });
    const profiles = await this.prisma.searchProfile.findMany({ where: { workspaceId: ctx.workspaceId, active: true } });
    for (const p of profiles) await this.outbox.emit({ workspaceId: ctx.workspaceId, eventType: 'evaluate.profile', aggregateId: p.id, dedupKey: `eval-profile:${p.id}:import:${importId}`, payload: {} });
    await this.audit.log({ workspaceId: ctx.workspaceId, actorId: ctx.userId, action: 'import.excel', entityType: 'ImportJob', entityId: importId, next: stats });
    return { dryRun: false, stats };
  }

  list(ctx: RequestContext) {
    return this.prisma.importJob.findMany({ where: { workspaceId: ctx.workspaceId }, orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, fileName: true, state: true, stats: true, createdAt: true } });
  }

  // ─────────── Dışa aktarma ───────────

  async exportData(ctx: RequestContext, kind: string, format: string, res: Response) {
    let headers: string[] = [];
    let rows: unknown[][] = [];
    if (kind === 'applications') {
      const data = await this.prisma.applicationAttempt.findMany({ where: { workspaceId: ctx.workspaceId }, orderBy: { createdAt: 'desc' } });
      const companies = new Map((await this.prisma.company.findMany({ where: { workspaceId: ctx.workspaceId }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
      headers = ['Tarih', 'Firma', 'Amaç', 'Alıcı', 'Mod', 'Durum', 'Sonuç', 'Not', 'Sağlayıcı ID'];
      rows = data.map((a) => [a.createdAt, companies.get(a.companyId), a.intentType, a.toEmail, a.sendMode, a.state, a.outcome, a.notes, a.providerMessageId]);
    } else if (kind === 'companies') {
      const data = await this.prisma.company.findMany({ where: { workspaceId: ctx.workspaceId }, include: { offices: true, contacts: true }, orderBy: { name: 'asc' } });
      headers = ['Firma', 'Web', 'İlçe', 'Sektörler', 'Q', 'Coverage', 'İletişim', 'Not'];
      rows = data.map((c) => [c.name, c.website, c.offices.map((o) => o.district).filter(Boolean).join(', '), c.sectors.join(', '), c.qScore, c.qCoverage, c.contacts.map((x) => `${x.email} (${x.kind})`).join('; '), c.notes]);
    } else if (kind === 'opportunities') {
      const data = await this.prisma.opportunity.findMany({ where: { workspaceId: ctx.workspaceId }, include: { company: true, job: true, searchProfile: true }, orderBy: { f: { sort: 'desc', nulls: 'last' } } });
      headers = ['Profil', 'Firma', 'İlan', 'Kategori', 'F', 'Q', 'Coverage', 'Konum', 'Durum'];
      rows = data.map((o) => [o.searchProfile.name, o.company.name, o.job?.title, o.category, o.f, o.q, o.coverage, o.locationState, o.status]);
    } else throw notFound('Dışa aktarma türü');
    const stamp = new Date().toISOString().slice(0, 10);
    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${kind}-${stamp}.csv"`);
      res.send(toCsv(headers, rows));
      return;
    }
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(kind);
    ws.addRow(headers);
    ws.getRow(1).font = { bold: true };
    // Formül enjeksiyonuna karşı her hücre metin olarak ve kaçırılarak yazılır.
    for (const r of rows) ws.addRow(r.map((v) => (typeof v === 'number' ? v : escapeCell(v))));
    ws.columns.forEach((c) => (c.width = 24));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${kind}-${stamp}.xlsx"`);
    res.send(Buffer.from(await wb.xlsx.writeBuffer()));
  }
}

@Controller('v1')
export class ImportsController {
  constructor(private readonly svc: ImportsService) {}

  @Post('imports/excel')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024 } }))
  preview(@Ctx() ctx: RequestContext, @UploadedFile() file?: Express.Multer.File) {
    return this.svc.preview(ctx, file);
  }

  @Post('imports/:id/commit')
  commit(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new ZodPipe(commitSchema)) body: z.infer<typeof commitSchema>) {
    return this.svc.commit(ctx, id, body);
  }

  @Get('imports')
  list(@Ctx() ctx: RequestContext) {
    return this.svc.list(ctx);
  }

  @Get('exports/:kind')
  export(@Ctx() ctx: RequestContext, @Param('kind') kind: string, @Query('format') format: string | undefined, @Res() res: Response) {
    return this.svc.exportData(ctx, kind, format === 'csv' ? 'csv' : 'xlsx', res);
  }
}

@Module({ controllers: [ImportsController], providers: [ImportsService] })
export class ImportsModule {}
