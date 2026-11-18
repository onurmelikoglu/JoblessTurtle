import { Injectable, Logger } from '@nestjs/common';
import { ApplicationDraft, DocumentVersion, Job, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import * as path from 'path';
import { sha256 } from '../common/crypto';
import { AppError, notFound } from '../common/errors';
import { OutboxService } from '../common/outbox.service';
import { PrismaService } from '../common/prisma.service';
import { StorageService } from '../common/storage.service';
import { addedSkillsOf, atsScore, AtsProfile, cvHas, cvHaystack, AtsRewriteModeValue, DEFAULT_ATS_REWRITE_MODE, DEFAULT_ATS_THRESHOLD, lockIdentity, StructuredCv } from '../domain/ats';
import { clampTitle, CvMaxPages, DEFAULT_CV_MAX_PAGES, rewriteBudget, shrinkCv, SHRINK_LEVEL_COUNT } from '../domain/cv-fit';
import { CV_FONTS, CV_PHOTO_FILE, CvLayout, CvLayoutMode, DEFAULT_CV_LAYOUT_MODE, fillLayout, LAYOUT_FIELDS, layoutProblem } from '../domain/cv-layout';
import { ATS_JOB_VARIANT, ATS_MAIN_VARIANT, EDITABLE_DRAFT_STATES, ORIGINAL_VARIANT } from '../domain/documents';
import { AiService } from './ai/ai.service';
import { chromiumPath, DEFAULT_MIN_SCALE, LAST_RESORT_MIN_SCALE, pdfPageCount, renderHtmlPdf } from './cv-html-render';
import { extractCvPhoto } from './cv-photo';
import { renderCvPdf } from './cv-render';
import { fetchListingDescription } from './connectors/listing-detail';
import { DraftingService } from './drafting.service';

/** Açıklaması bundan kısa ilanın gereksinimleri çıkarılmaz; oran yanıltıcı olurdu. Tek cümlelik ilanlar yine puanlanır. */
const MIN_DESCRIPTION_LENGTH = 60;
/** İlan metni ilan sayfasından okunamadıysa aynı ilan için bu süre içinde yeniden denenmez. */
const DETAIL_RETRY_MS = 7 * 24 * 60 * 60_000;
const DETAIL_URLS_PER_JOB = 4;
/** Hazırlık başarısız olduysa aynı CV/ilan için bu süre içinde yeniden denenmez. */
const RETRY_AFTER_MS = 60 * 60_000;
/** İlana özel sürüm, ana sürümden en az bu kadar puan iyiyse ana yapılması önerilir. */
const PROMOTION_MARGIN = 3;
const PROMOTION_SAMPLE = 20;
const STALE_JOB_VARIANT_DAYS = 14;
const DESCRIPTION_LIMIT = 6000;
/** Tasarım şablonu hazırlanırken bu süre içinde "hazırlanıyor" görünür. */
const LAYOUT_PREPARING_MS = 30 * 60_000;

export type AtsStatus = 'ready' | 'preparing' | 'no_job' | 'no_description' | 'no_cv' | 'unavailable';

export interface AtsItem {
  documentId: string;
  variant: string;
  label: string;
  score: number;
  missing: string[];
  addedSkills: string[];
  attached: boolean;
}

export interface AtsOverview {
  status: AtsStatus;
  threshold: number;
  items: AtsItem[];
  best: { documentId: string; score: number } | null;
  /** Ekli CV'nin oranı; ekli CV oranlanamadıysa null. */
  attachedScore: number | null;
}

type CvDoc = Pick<DocumentVersion, 'id' | 'variant' | 'label' | 'language' | 'content' | 'addedSkills' | 'createdAt' | 'objectKey' | 'fileName' | 'targetJobId' | 'parentId'>;

export type CvLayoutState = 'ready' | 'preparing' | 'failed' | 'none' | 'unsupported';

export interface CvLayoutStatus {
  documentId: string;
  fileName: string;
  language: string;
  state: CvLayoutState;
  usesPhoto: boolean;
  reason: string | null;
  createdAt: Date | null;
}

const failKey = (id: string) => `ats:fail:${id}`;
const detailKey = (jobId: string) => `ats:detail:${jobId}`;
const layoutKey = (id: string) => `ats:layout:${id}`;

/**
 * CV'nin ilana ATS uyumu. Yapay zekâ orijinal CV'yi ve ilanı bir kez yapısal hâle getirir; oran yapay zekâsız hesaplanır.
 * İyileştirme orijinal CV'den üretilir: dilde ana ATS sürümü yoksa o olur; varsa ve bu ilanda eşiğin altındaysa ana
 * sürümün üzerine yazmadan yalnız bu ilan için ayrı bir sürüm üretilir. Gönderimden sonra ilana özel sürüm diğer açık
 * ilanlarda ana sürümden iyiyse kullanıcıya "ana yapılsın mı" diye sorulur, değilse arşivlenir.
 */
@Injectable()
export class AtsService {
  private readonly logger = new Logger('Ats');
  private readonly fitScales = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly ai: AiService,
    private readonly outbox: OutboxService,
    private readonly drafting: DraftingService,
  ) {}

  async settings(workspaceId: string): Promise<{ threshold: number; mode: AtsRewriteModeValue; layout: CvLayoutMode; maxPages: CvMaxPages }> {
    const ai = await this.ai.settings(workspaceId);
    return { threshold: ai.atsThreshold ?? DEFAULT_ATS_THRESHOLD, mode: ai.atsRewriteMode ?? DEFAULT_ATS_REWRITE_MODE, layout: ai.atsCvLayout ?? DEFAULT_CV_LAYOUT_MODE, maxPages: ai.atsMaxPages ?? DEFAULT_CV_MAX_PAGES };
  }

  /** Taslağın dilindeki CV sürümleri: orijinal (en yeni), ana ATS ve bu ilanın ATS sürümü. */
  private async cvVersions(candidateId: string, language: string, jobId: string | null): Promise<CvDoc[]> {
    const docs = await this.prisma.documentVersion.findMany({
      where: { candidateId, type: 'cv', language, archived: false, scanState: 'clean', OR: [{ variant: { in: [ORIGINAL_VARIANT, ATS_MAIN_VARIANT] } }, ...(jobId ? [{ variant: ATS_JOB_VARIANT, targetJobId: jobId }] : [])] },
      orderBy: { createdAt: 'desc' },
    });
    const newest = (variant: string) => docs.find((d) => d.variant === variant);
    return [newest(ORIGINAL_VARIANT), newest(ATS_MAIN_VARIANT), newest(ATS_JOB_VARIANT)].filter((d): d is DocumentVersion => !!d);
  }

  private async failedRecently(id: string) {
    const kv = await this.prisma.keyValue.findUnique({ where: { key: failKey(id) } });
    const at = (kv?.value as { at?: string } | null)?.at;
    return !!at && Date.now() - Date.parse(at) < RETRY_AFTER_MS;
  }

  private markFailed(id: string) {
    const value = { at: new Date().toISOString() };
    return this.prisma.keyValue.upsert({ where: { key: failKey(id) }, create: { key: failKey(id), value }, update: { value } });
  }

  /** Orijinal CV dosyasını yapısal içeriğe çevirir (dosyayı yalnızca Claude/Codex CLI okuyabilir). */
  async ensureStructure(doc: CvDoc, workspaceId: string): Promise<StructuredCv | null> {
    if (doc.content) return doc.content as unknown as StructuredCv;
    if (doc.variant !== ORIGINAL_VARIANT || (await this.failedRecently(doc.id))) return null;
    const fileName = `cv${path.extname(doc.fileName) || '.pdf'}`;
    const r = await this.ai.run({
      workspaceId,
      kind: 'cv_structure',
      input: { documentId: doc.id, fileName },
      files: [{ name: fileName, data: await this.storage.get(doc.objectKey) }],
      allowManual: false,
      allowTemplate: false,
      entityType: 'DocumentVersion',
      entityId: doc.id,
    });
    if (r.status !== 'succeeded') {
      await this.markFailed(doc.id);
      this.logger.warn(`CV yapısal hâle getirilemedi (${doc.id}): ${r.status}`);
      return null;
    }
    const content = r.output as StructuredCv;
    await this.prisma.documentVersion.update({ where: { id: doc.id }, data: { content: content as unknown as Prisma.InputJsonValue } });
    return content;
  }

  async ensureJobProfile(job: Pick<Job, 'id' | 'workspaceId' | 'title' | 'description' | 'atsProfile'>): Promise<AtsProfile | null> {
    if (job.atsProfile) return job.atsProfile as unknown as AtsProfile;
    if (!hasDescription(job) || (await this.failedRecently(job.id))) return null;
    const r = await this.ai.run({
      workspaceId: job.workspaceId,
      kind: 'job_ats_profile',
      input: { title: job.title, description: (job.description ?? '').slice(0, DESCRIPTION_LIMIT) },
      allowManual: false,
      allowTemplate: false,
      entityType: 'Job',
      entityId: job.id,
    });
    if (r.status !== 'succeeded') {
      await this.markFailed(job.id);
      return null;
    }
    const profile = r.output as AtsProfile;
    await this.prisma.job.update({ where: { id: job.id }, data: { atsProfile: profile as unknown as Prisma.InputJsonValue, atsProfileAt: new Date() } });
    return profile;
  }

  private async detailTriedRecently(jobId: string) {
    const kv = await this.prisma.keyValue.findUnique({ where: { key: detailKey(jobId) } });
    const at = (kv?.value as { at?: string } | null)?.at;
    return !!at && Date.now() - Date.parse(at) < DETAIL_RETRY_MS;
  }

  /**
   * İlan sitelerinin listeleri ilan metnini vermez. Metni olmayan ilanın kaynak sayfaları (robots.txt izin veriyorsa)
   * bir kez okunur ve bulunan en uzun metin ilana yazılır; okunamazsa bir hafta yeniden denenmez.
   */
  async ensureDescription<T extends Pick<Job, 'id' | 'description' | 'atsProfile'>>(job: T): Promise<T> {
    if (job.atsProfile || hasDescription(job) || (await this.detailTriedRecently(job.id))) return job;
    const listings = await this.prisma.jobListing.findMany({ where: { jobId: job.id, canonicalUrl: { not: null } }, orderBy: { lastSeenAt: 'desc' }, select: { canonicalUrl: true } });
    const urls = [...new Set(listings.map((l) => l.canonicalUrl as string))].slice(0, DETAIL_URLS_PER_JOB);
    let best = (job.description ?? '').trim();
    for (const url of urls) {
      const text = await fetchListingDescription(url).catch(() => null);
      if (text && text.length > best.length) best = text;
      if (best.length >= MIN_DESCRIPTION_LENGTH * 4) break;
    }
    const value = { at: new Date().toISOString() };
    await this.prisma.keyValue.upsert({ where: { key: detailKey(job.id) }, create: { key: detailKey(job.id), value }, update: { value } });
    if (best.length <= (job.description ?? '').trim().length) return job;
    await this.prisma.job.update({ where: { id: job.id }, data: { description: best } });
    return { ...job, description: best };
  }

  /** Yapay zekâ gerektiren eksikleri tamamlar: ilan metni, CV'lerin yapısı ve ilanın gereksinimleri. */
  async prepare(candidateId: string, jobId: string, language: string) {
    const [found, candidate] = await Promise.all([this.prisma.job.findUnique({ where: { id: jobId } }), this.prisma.candidateProfile.findUnique({ where: { id: candidateId } })]);
    if (!found || !candidate) return { status: 'skipped' };
    const job = await this.ensureDescription(found);
    const docs = await this.cvVersions(candidateId, language, jobId);
    for (const doc of docs) await this.ensureStructure(doc, candidate.workspaceId);
    await this.ensureJobProfile(job);
    const original = docs.find((d) => d.variant === ORIGINAL_VARIANT);
    if (original) await this.scheduleLayout(candidate.workspaceId, original.id);
    return { status: 'prepared' };
  }

  private async score(doc: CvDoc, job: Pick<Job, 'id'>, cv: StructuredCv, profile: AtsProfile, years: number | null, profileAt: Date | null) {
    const cached = await this.prisma.atsScore.findUnique({ where: { documentId_jobId: { documentId: doc.id, jobId: job.id } } });
    if (cached && (!profileAt || cached.computedAt >= profileAt)) return { score: cached.score, missing: cached.missing };
    const r = atsScore(cv, profile, years);
    const data = { score: r.score, breakdown: r.breakdown as unknown as Prisma.InputJsonValue, missing: r.missing, computedAt: new Date() };
    await this.prisma.atsScore.upsert({ where: { documentId_jobId: { documentId: doc.id, jobId: job.id } }, create: { documentId: doc.id, jobId: job.id, ...data }, update: data });
    return { score: r.score, missing: r.missing };
  }

  /**
   * Taslağın ATS özeti. Eksik yapı ya da gereksinim varsa (ve yakın zamanda başarısız olmadıysa) hazırlık sıraya alınır
   * ve "preparing" döner; schedule=false ise sıraya alınmaz (otomatik başvuru kendi içinde hazırlar).
   */
  async overview(draft: Pick<ApplicationDraft, 'id' | 'workspaceId' | 'candidateId' | 'jobId' | 'language'>, attachedIds: string[], opts: { schedule?: boolean } = {}): Promise<AtsOverview> {
    const { threshold } = await this.settings(draft.workspaceId);
    const empty = (status: AtsStatus): AtsOverview => ({ status, threshold, items: [], best: null, attachedScore: null });
    if (!draft.jobId) return empty('no_job');
    const [job, candidate] = await Promise.all([this.prisma.job.findUnique({ where: { id: draft.jobId } }), this.prisma.candidateProfile.findUnique({ where: { id: draft.candidateId }, select: { experienceYears: true } })]);
    if (!job) return empty('no_job');
    const docs = await this.cvVersions(draft.candidateId, draft.language, job.id);
    if (!docs.length) return empty('no_cv');
    if (!job.atsProfile && !hasDescription(job)) {
      if (await this.detailTriedRecently(job.id)) return empty('no_description');
      if (opts.schedule !== false) await this.outbox.emit({ workspaceId: draft.workspaceId, eventType: 'ats.prepare', aggregateId: draft.id, dedupKey: `ats-detail:${draft.id}:${job.id}:${new Date().toISOString().slice(0, 10)}`, payload: { candidateId: draft.candidateId, jobId: job.id, language: draft.language } });
      return empty('preparing');
    }
    const original = docs.find((d) => d.variant === ORIGINAL_VARIANT);
    const missingAi = !job.atsProfile || (!!original && !original.content);
    if (missingAi) {
      const failed = (await this.failedRecently(job.id)) || (!!original && !original.content && (await this.failedRecently(original.id)));
      if (failed) return empty('unavailable');
      if (opts.schedule !== false) await this.outbox.emit({ workspaceId: draft.workspaceId, eventType: 'ats.prepare', aggregateId: draft.id, dedupKey: `ats-prepare:${draft.id}:${job.id}:${docs.map((d) => d.id).join(',')}`, payload: { candidateId: draft.candidateId, jobId: job.id, language: draft.language } });
      return empty('preparing');
    }
    const profile = job.atsProfile as unknown as AtsProfile;
    const items: AtsItem[] = [];
    for (const doc of docs) {
      const cv = (doc.content as unknown as StructuredCv | null) ?? null;
      if (!cv) continue;
      const s = await this.score(doc, job, cv, profile, candidate?.experienceYears ?? null, job.atsProfileAt);
      items.push({ documentId: doc.id, variant: doc.variant, label: doc.label, score: s.score, missing: s.missing, addedSkills: doc.addedSkills, attached: attachedIds.includes(doc.id) });
    }
    const best = items.reduce<AtsItem | null>((top, i) => (!top || i.score > top.score ? i : top), null);
    return { status: 'ready', threshold, items, best: best ? { documentId: best.documentId, score: best.score } : null, attachedScore: items.find((i) => i.attached)?.score ?? null };
  }

  /**
   * Taslak için iyileştirilmiş CV hazırlar ve ekler. Dilde ana ATS sürümü yoksa ana sürüm üretilir; varsa ve bu ilanda
   * eşiği geçiyorsa yalnızca ek değişir; geçmiyorsa bu ilana özel sürüm üretilir. Orijinal hiçbir zaman değişmez.
   */
  async improve(draftId: string, actorId: string | null): Promise<{ status: 'improved' | 'attached' | 'unavailable'; documentId?: string; score?: number; previous?: number | null }> {
    const draft = await this.prisma.applicationDraft.findUnique({ where: { id: draftId } });
    if (!draft) throw notFound('Taslak');
    if (!draft.jobId) throw new AppError(422, 'ATS_NO_JOB', 'Firmaya genel başvuruda ilan olmadığı için ATS oranı hesaplanamaz');
    const job = await this.prisma.job.findUniqueOrThrow({ where: { id: draft.jobId }, include: { company: { select: { name: true } } } });
    const candidate = await this.prisma.candidateProfile.findUniqueOrThrow({ where: { id: draft.candidateId } });
    await this.prepare(draft.candidateId, job.id, draft.language);
    const rev = await this.drafting.currentRevision(draft.id);
    const attachedIds = rev?.documentIds ?? [];
    const overview = await this.overview(draft, attachedIds, { schedule: false });
    if (overview.status !== 'ready') return { status: 'unavailable' };
    const docs = await this.cvVersions(draft.candidateId, draft.language, job.id);
    const original = docs.find((d) => d.variant === ORIGINAL_VARIANT);
    const originalCv = original?.content as unknown as StructuredCv | null;
    if (!original || !originalCv) return { status: 'unavailable' };
    const scoreOf = (variant: string) => overview.items.find((i) => i.variant === variant);
    const main = scoreOf(ATS_MAIN_VARIANT);
    const jobVersion = scoreOf(ATS_JOB_VARIANT);
    const previous = overview.attachedScore;

    const ready = [jobVersion, main].find((i) => i && i.score >= overview.threshold);
    const rewriteAttached = !!actorId && !!ready?.attached;
    if (ready && !rewriteAttached) {
      await this.attach(draft, ready.documentId, actorId);
      return { status: 'attached', documentId: ready.documentId, score: ready.score, previous };
    }

    const { mode, maxPages } = await this.settings(draft.workspaceId);
    const profile = job.atsProfile as unknown as AtsProfile;
    const missing = overview.items.find((i) => i.variant === ORIGINAL_VARIANT)?.missing ?? [];
    const originalPages = (await this.prisma.documentVersion.findUnique({ where: { id: original.id }, select: { layout: true } }))?.layout as unknown as CvLayout | null;
    const budget = rewriteBudget(originalCv, originalPages?.pages ?? 1, maxPages);
    const r = await this.ai.run({
      workspaceId: draft.workspaceId,
      kind: 'cv_ats_rewrite',
      input: { cv: originalCv, profile, missing, facts: candidate.verifiedFacts, mode, language: draft.language, jobTitle: job.title, company: job.company.name, budget },
      allowManual: false,
      allowTemplate: false,
      useCache: !rewriteAttached,
      entityType: 'ApplicationDraft',
      entityId: draft.id,
      createdById: actorId,
    });
    if (r.status !== 'succeeded') return { status: 'unavailable' };
    const output = r.output as { cv: StructuredCv; addedSkills: string[] };
    const rewritten = clampTitle(originalCv, lockIdentity(originalCv, output.cv));
    const replaced = rewriteAttached ? docs.find((d) => d.id === ready!.documentId) : undefined;
    const variant = replaced?.variant ?? (main ? ATS_JOB_VARIANT : ATS_MAIN_VARIANT);
    const targetJobId = replaced ? replaced.targetJobId : variant === ATS_JOB_VARIANT ? job.id : null;
    const keepTerms = [...profile.hardSkills, ...profile.tools, ...profile.titleKeywords];
    const addedFor = (cv: StructuredCv) => (mode === 'fill_gaps' ? [...new Set([...addedSkillsOf(originalCv, cv), ...output.addedSkills])].filter((t) => cvHas(cvHaystack(cv), t)) : []);
    const stored = await this.store(original, rewritten, { variant, targetJobId, addedSkills: addedFor, company: job.company.name, language: draft.language, keepTerms });
    const doc = replaced ? stored : await this.yieldToEarlierMain(stored, job.id, job.company.name);
    const cv = doc.content as unknown as StructuredCv;
    const scored = await this.score(doc, job, cv, profile, candidate.experienceYears, job.atsProfileAt);
    await this.attach(draft, doc.id, actorId);
    if (replaced) await this.supersede(replaced.id, doc.id);
    return { status: 'improved', documentId: doc.id, score: scored.score, previous };
  }

  private async store(original: CvDoc & { candidateId?: string }, rewritten: StructuredCv, opts: { variant: string; targetJobId: string | null; addedSkills: (cv: StructuredCv) => string[]; company: string; language: string; keepTerms: string[] }) {
    const source = await this.prisma.documentVersion.findUniqueOrThrow({ where: { id: original.id } });
    const { pdf, cv } = await this.renderFitted(source, rewritten, opts.language, opts.keepTerms);
    const objectKey = `candidates/${source.candidateId}/${randomUUID()}`;
    await this.storage.put(objectKey, pdf);
    const lang = opts.language.toUpperCase();
    const base = (cv.name || 'CV').replace(/[^\p{L}\p{N} ]/gu, '').trim().replace(/\s+/g, '-') || 'CV';
    return this.prisma.documentVersion.create({
      data: {
        workspaceId: source.workspaceId,
        candidateId: source.candidateId,
        type: 'cv',
        language: opts.language,
        label: opts.variant === ATS_MAIN_VARIANT ? `CV ${lang} — ATS` : `CV ${lang} — ATS · ${opts.company}`.slice(0, 120),
        fileName: `${base}-CV-${lang}.pdf`,
        objectKey,
        sha256: sha256(pdf),
        mime: 'application/pdf',
        size: pdf.length,
        scanState: 'clean',
        variant: opts.variant,
        parentId: source.id,
        targetJobId: opts.targetJobId,
        content: cv as unknown as Prisma.InputJsonValue,
        addedSkills: opts.addedSkills(cv),
      },
    });
  }

  /**
   * İyileştirilmiş CV'nin PDF'i: ayar "orijinal görünüm" ise orijinal CV'nin tasarım şablonuyla (yoksa önce hazırlanır),
   * şablon kullanılamazsa sade ATS şablonuyla çizilir.
   */
  private async renderCv(original: DocumentVersion, cv: StructuredCv, language: string, minScale = DEFAULT_MIN_SCALE): Promise<{ pdf: Buffer; fits: boolean }> {
    const { layout: mode, maxPages } = await this.settings(original.workspaceId);
    if (mode === 'original') {
      const layout = await this.ensureLayout(original);
      if (layout) {
        try {
          const floor = await this.layoutFitScale(original, layout);
          const r = await this.renderWithLayout(layout, cv, Math.min(layout.pages, maxPages), Math.min(minScale, floor));
          return { pdf: r.pdf, fits: r.fits };
        } catch (e) {
          this.logger.warn(`CV orijinal tasarımla çizilemedi (${original.id}): ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    const pdf = await renderCvPdf(cv, language === 'en' ? 'en' : 'tr');
    return { pdf, fits: pdfPageCount(pdf) <= maxPages };
  }

  /**
   * Orijinal içeriğin şablonda sığdığı ölçek (yoksa bir kez hesaplanıp şablona yazılır). Yapay zekânın kurduğu şablon
   * orijinalden biraz seyrek olabilir; iyileştirilmiş CV, orijinal kadar uzunsa kısaltılmadan aynı ölçekte sığar.
   */
  private async layoutFitScale(original: DocumentVersion, layout: CvLayout): Promise<number> {
    if (layout.fitScale) return layout.fitScale;
    const key = `${original.id}:${layout.createdAt}`;
    const known = this.fitScales.get(key);
    if (known) return known;
    const cv = original.content as unknown as StructuredCv | null;
    if (!cv) return DEFAULT_MIN_SCALE;
    const trial = await this.renderWithLayout(layout, cv, layout.pages, LAST_RESORT_MIN_SCALE);
    const fitScale = trial.fits ? trial.scale : LAST_RESORT_MIN_SCALE;
    this.fitScales.set(key, fitScale);
    await this.prisma.documentVersion.update({ where: { id: original.id }, data: { layout: { ...layout, fitScale } as unknown as Prisma.InputJsonValue } });
    return fitScale;
  }

  private async renderWithLayout(layout: CvLayout, cv: StructuredCv, targetPages = layout.pages, minScale = DEFAULT_MIN_SCALE) {
    const photo = layout.usesPhoto && layout.photoKey ? `data:image/png;base64,${(await this.storage.get(layout.photoKey)).toString('base64')}` : null;
    return renderHtmlPdf(fillLayout(layout.html, cv, photo), targetPages, minScale);
  }

  /**
   * CV'yi sayfa sınırına sığdırarak çizer: sınırı aşarsa önce ilanla eşleşmeyen beceriler, sonra eski deneyimlerin fazla
   * maddeleri, özet ve projeler kısaltılarak yeniden çizilir. Sığan (ya da en kısa) içerik ve PDF'i döner.
   */
  private async renderFitted(original: DocumentVersion, cv: StructuredCv, language: string, keepTerms: string[]): Promise<{ pdf: Buffer; cv: StructuredCv }> {
    let current = cv;
    let r = await this.renderCv(original, current, language);
    for (let level = 0; level < SHRINK_LEVEL_COUNT && !r.fits; level++) {
      const shorter = shrinkCv(cv, keepTerms, level);
      if (!shorter) break;
      current = shorter;
      r = await this.renderCv(original, current, language);
    }
    if (!r.fits) r = await this.renderCv(original, current, language, LAST_RESORT_MIN_SCALE);
    if (!r.fits) this.logger.warn(`İyileştirilmiş CV sayfa sınırına sığdırılamadı (${original.id}): ${pdfPageCount(r.pdf)} sayfa`);
    return { pdf: r.pdf, cv: current };
  }

  private async layoutFailure(id: string): Promise<{ at: string; reason: string } | null> {
    const kv = await this.prisma.keyValue.findUnique({ where: { key: layoutKey(id) } });
    const value = kv?.value as { state?: string; at?: string; reason?: string } | null;
    return value?.state === 'failed' && value.at ? { at: value.at, reason: value.reason ?? '' } : null;
  }

  private setLayoutState(id: string, state: 'preparing' | 'failed', reason?: string) {
    const value = { state, at: new Date().toISOString(), ...(reason ? { reason } : {}) };
    return this.prisma.keyValue.upsert({ where: { key: layoutKey(id) }, create: { key: layoutKey(id), value }, update: { value } });
  }

  /**
   * Orijinal CV'nin tasarımını HTML şablonuna aktarır (bir kez; sonucu belgeye yazılır). Fotoğraf PDF'ten çıkarılır,
   * şablon güvenlik ve alan denetiminden ve orijinal içerikle deneme çiziminden geçmezse kullanılmaz.
   */
  async ensureLayout(original: DocumentVersion): Promise<CvLayout | null> {
    if (original.layout) return original.layout as unknown as CvLayout;
    const cv = original.content as unknown as StructuredCv | null;
    if (original.variant !== ORIGINAL_VARIANT || !cv || !chromiumPath()) return null;
    const failure = await this.layoutFailure(original.id);
    if (failure && Date.now() - Date.parse(failure.at) < RETRY_AFTER_MS) return null;
    await this.setLayoutState(original.id, 'preparing');
    const fail = async (reason: string) => {
      this.logger.warn(`CV tasarım şablonu hazırlanamadı (${original.id}): ${reason}`);
      await this.setLayoutState(original.id, 'failed', reason);
      return null;
    };
    const file = await this.storage.get(original.objectKey);
    const isPdf = original.mime === 'application/pdf' || /\.pdf$/i.test(original.fileName);
    const photo = isPdf ? await extractCvPhoto(file) : null;
    const pages = isPdf ? Math.max(1, pdfPageCount(file)) : 1;
    const fileName = `cv${path.extname(original.fileName) || '.pdf'}`;
    const r = await this.ai.run({
      workspaceId: original.workspaceId,
      kind: 'cv_layout',
      input: { fileName, photoFile: photo ? CV_PHOTO_FILE : null, photoWidth: photo?.width, photoHeight: photo?.height, pages, cv, fields: LAYOUT_FIELDS, fonts: Object.keys(CV_FONTS).join(', ') },
      files: [{ name: fileName, data: file }, ...(photo ? [{ name: CV_PHOTO_FILE, data: photo.data }] : [])],
      allowManual: false,
      allowTemplate: false,
      entityType: 'DocumentVersion',
      entityId: original.id,
    });
    if (r.status !== 'succeeded') return fail(`yapay zekâ görevi ${r.status}`);
    const output = r.output as { html: string; usesPhoto: boolean };
    const problem = layoutProblem(output.html, cv);
    if (problem) return fail(problem);
    let photoKey: string | null = null;
    if (output.usesPhoto && photo) {
      photoKey = `candidates/${original.candidateId}/${randomUUID()}`;
      await this.storage.put(photoKey, photo.data);
    }
    const layout: CvLayout = { html: output.html, usesPhoto: !!photoKey, photoKey, pages, createdAt: new Date().toISOString() };
    try {
      const trial = await this.renderWithLayout(layout, cv, pages, LAST_RESORT_MIN_SCALE);
      layout.fitScale = trial.fits ? trial.scale : LAST_RESORT_MIN_SCALE;
    } catch (e) {
      if (photoKey) await this.storage.delete(photoKey).catch(() => undefined);
      return fail(`deneme çizimi başarısız: ${e instanceof Error ? e.message : String(e)}`);
    }
    await this.prisma.documentVersion.update({ where: { id: original.id }, data: { layout: layout as unknown as Prisma.InputJsonValue } });
    await this.prisma.keyValue.deleteMany({ where: { key: layoutKey(original.id) } });
    return layout;
  }

  /** Şablonu yoksa ve ayar orijinal görünümse arka planda hazırlatır. */
  async scheduleLayout(workspaceId: string, originalId: string, opts: { force?: boolean } = {}) {
    const { layout: mode } = await this.settings(workspaceId);
    if (mode !== 'original' || !chromiumPath()) return;
    const doc = await this.prisma.documentVersion.findUnique({ where: { id: originalId }, select: { layout: true, content: true } });
    if (!doc || (doc.layout && !opts.force)) return;
    if (!opts.force && (await this.layoutFailure(originalId))) return;
    await this.outbox.emit({ workspaceId, eventType: 'ats.layout', aggregateId: originalId, dedupKey: `ats-layout:${originalId}:${opts.force ? Date.now() : 'auto'}`, payload: { force: opts.force === true } });
  }

  /** Worker işi: şablonu (gerekirse yeniden) hazırlar, ardından bu CV'den üretilmiş ATS sürümlerini yeni görünümle çizer. */
  async buildLayout(originalId: string, force: boolean) {
    let original = await this.prisma.documentVersion.findUnique({ where: { id: originalId } });
    if (!original || original.archived) return { status: 'skipped' };
    if (force && original.layout) {
      const old = original.layout as unknown as CvLayout;
      original = await this.prisma.documentVersion.update({ where: { id: originalId }, data: { layout: Prisma.DbNull } });
      if (old.photoKey) await this.storage.delete(old.photoKey).catch(() => undefined);
    }
    if (force) await this.prisma.keyValue.deleteMany({ where: { key: layoutKey(originalId) } });
    if (!original.content) await this.ensureStructure(original, original.workspaceId);
    original = await this.prisma.documentVersion.findUniqueOrThrow({ where: { id: originalId } });
    const layout = await this.ensureLayout(original);
    if (!layout) return { status: 'failed' };
    const refreshed = await this.refreshRenders(original.workspaceId, originalId);
    return { status: 'ready', refreshed };
  }

  /**
   * ATS sürümlerini güncel görünüm ayarıyla yeniden çizer. Hiç gönderilmemiş sürümün dosyası yerinde değişir; gönderilmiş
   * sürüm (gönderilen dosya kaydı bozulmasın diye) korunur, yerine yeni bir sürüm açılıp düzenlenebilir taslaklara takılır.
   */
  async refreshRenders(workspaceId: string, parentId?: string) {
    const docs = await this.prisma.documentVersion.findMany({
      where: { workspaceId, type: 'cv', archived: false, variant: { in: [ATS_MAIN_VARIANT, ATS_JOB_VARIANT] }, content: { not: Prisma.DbNull }, ...(parentId ? { parentId } : { parentId: { not: null } }) },
    });
    let count = 0;
    for (const doc of docs) {
      const parent = await this.prisma.documentVersion.findUnique({ where: { id: doc.parentId! } });
      if (!parent) continue;
      const fitted = await this.renderFitted(parent, doc.content as unknown as StructuredCv, doc.language, []);
      const pdf = fitted.pdf;
      const objectKey = `candidates/${doc.candidateId}/${randomUUID()}`;
      await this.storage.put(objectKey, pdf);
      const file = { objectKey, sha256: sha256(pdf), size: pdf.length, content: fitted.cv as unknown as Prisma.InputJsonValue };
      const sent = await this.prisma.applicationAttempt.count({ where: { documentHashes: { array_contains: [{ id: doc.id }] } } });
      if (!sent) {
        await this.prisma.documentVersion.update({ where: { id: doc.id }, data: file });
        await this.prisma.atsScore.deleteMany({ where: { documentId: doc.id } });
        await this.storage.delete(doc.objectKey).catch(() => undefined);
      } else {
        const { id, createdAt: _createdAt, ...rest } = doc;
        const copy = await this.prisma.documentVersion.create({
          data: { ...rest, ...file, layout: Prisma.DbNull },
        });
        await this.prisma.documentVersion.update({ where: { id }, data: { archived: true, pendingPromotion: false } });
        await this.swapInDrafts(id, copy.id);
      }
      count += 1;
    }
    return count;
  }

  /**
   * Aynı anda birkaç ilan için iyileştirme çalışırsa (toplu iyileştirme) her biri "ana sürüm yok" görüp ana sürüm
   * üretebilir. Kendinden önce kaydedilmiş bir ana sürüm varsa yeni olan bu ilana özel sürüme dönüşür.
   */
  private async yieldToEarlierMain(doc: DocumentVersion, jobId: string, company: string): Promise<DocumentVersion> {
    if (doc.variant !== ATS_MAIN_VARIANT) return doc;
    const earlier = await this.prisma.documentVersion.count({
      where: { candidateId: doc.candidateId, type: 'cv', language: doc.language, variant: ATS_MAIN_VARIANT, archived: false, id: { not: doc.id }, createdAt: { lte: doc.createdAt } },
    });
    if (!earlier) return doc;
    const label = `CV ${doc.language.toUpperCase()} — ATS · ${company}`.slice(0, 120);
    return this.prisma.documentVersion.update({ where: { id: doc.id }, data: { variant: ATS_JOB_VARIANT, targetJobId: jobId, label } });
  }

  /** Yeniden iyileştirilen sürümün eskisi arşivlenir; onu kullanan düzenlenebilir taslaklara yenisi takılır. */
  private async supersede(oldId: string, newId: string) {
    await this.prisma.documentVersion.update({ where: { id: oldId }, data: { archived: true, pendingPromotion: false } });
    await this.swapInDrafts(oldId, newId);
  }

  private async swapInDrafts(oldId: string, newId: string) {
    const revisions = await this.prisma.draftRevision.findMany({ where: { documentIds: { has: oldId } }, select: { draftId: true, revision: true } });
    for (const rev of revisions) {
      const draft = await this.prisma.applicationDraft.findUnique({ where: { id: rev.draftId } });
      if (!draft || draft.currentRevision !== rev.revision || !EDITABLE_DRAFT_STATES.includes(draft.status)) continue;
      await this.attach(draft, newId, null);
    }
  }

  /** Profildeki orijinal CV'lerin tasarım şablonu durumu. */
  async layouts(workspaceId: string): Promise<CvLayoutStatus[]> {
    const docs = await this.prisma.documentVersion.findMany({
      where: { workspaceId, type: 'cv', variant: ORIGINAL_VARIANT, archived: false, scanState: 'clean' },
      orderBy: { createdAt: 'desc' },
      select: { id: true, fileName: true, language: true, layout: true },
    });
    const newest = docs.filter((d, i) => docs.findIndex((o) => o.language === d.language) === i);
    const states = await this.prisma.keyValue.findMany({ where: { key: { in: newest.map((d) => layoutKey(d.id)) } } });
    const stateOf = new Map(states.map((kv) => [kv.key, kv.value as { state?: string; at?: string; reason?: string }]));
    const supported = !!chromiumPath();
    return newest.map((d) => {
      const layout = d.layout as unknown as CvLayout | null;
      const kv = stateOf.get(layoutKey(d.id));
      const preparing = kv?.state === 'preparing' && !!kv.at && Date.now() - Date.parse(kv.at) < LAYOUT_PREPARING_MS;
      const state: CvLayoutState = layout ? 'ready' : !supported ? 'unsupported' : preparing ? 'preparing' : kv?.state === 'failed' ? 'failed' : 'none';
      return { documentId: d.id, fileName: d.fileName, language: d.language, state, usesPhoto: layout?.usesPhoto ?? false, reason: state === 'failed' ? (kv?.reason ?? null) : null, createdAt: layout ? new Date(layout.createdAt) : null };
    });
  }

  /** Şablonun orijinal içerikle doldurulmuş hâli: kullanıcı görünümü onaylasın diye. */
  async layoutPreview(workspaceId: string, documentId: string): Promise<{ pdf: Buffer; fileName: string }> {
    const doc = await this.prisma.documentVersion.findFirst({ where: { id: documentId, workspaceId, variant: ORIGINAL_VARIANT } });
    const layout = doc?.layout as unknown as CvLayout | null;
    if (!doc || !layout || !doc.content) throw notFound('CV şablonu');
    const { pdf } = await this.renderWithLayout(layout, doc.content as unknown as StructuredCv);
    return { pdf, fileName: doc.fileName.replace(/\.[^.]+$/, '') + '-sablon.pdf' };
  }

  async requestLayout(workspaceId: string, documentId: string) {
    const doc = await this.prisma.documentVersion.findFirst({ where: { id: documentId, workspaceId, type: 'cv', variant: ORIGINAL_VARIANT } });
    if (!doc) throw notFound('CV');
    if (!chromiumPath()) throw new AppError(422, 'CV_LAYOUT_UNSUPPORTED', 'Bu sunucuda PDF çizici (Chromium) kurulu değil');
    await this.setLayoutState(doc.id, 'preparing');
    await this.outbox.emit({ workspaceId, eventType: 'ats.layout', aggregateId: doc.id, dedupKey: `ats-layout:${doc.id}:${Date.now()}`, payload: { force: true } });
    return { queued: true };
  }

  /** Taslakta aynı dildeki CV ekini verilen sürümle değiştirir (portföy ve diğer ekler kalır). */
  async attach(draft: ApplicationDraft, documentId: string, actorId: string | null) {
    const rev = await this.drafting.currentRevision(draft.id);
    if (!rev) return;
    const current = await this.prisma.documentVersion.findMany({ where: { id: { in: rev.documentIds } }, select: { id: true, type: true } });
    const keep = current.filter((d) => d.type !== 'cv').map((d) => d.id);
    const documentIds = [documentId, ...keep];
    if (documentIds.length === rev.documentIds.length && documentIds.every((id) => rev.documentIds.includes(id))) return;
    const fresh = await this.prisma.applicationDraft.findUniqueOrThrow({ where: { id: draft.id } });
    await this.drafting.addRevision(fresh, { toEmail: rev.toEmail, subject: rev.subject, body: rev.body, documentIds, links: rev.links }, { createdById: actorId, generator: 'ai:ats', sourceRefs: rev.sourceRefs });
  }

  /**
   * Otomatik başvuruda gönderimden önce: ekli CV eşiğin altındaysa iyileştirir. Yapay zekâ yoksa ya da ilan metni
   * yoksa olduğu gibi devam edilir; sonuç neden olarak döner.
   */
  async autoImprove(draftId: string): Promise<'ok' | 'improved' | 'skipped'> {
    const draft = await this.prisma.applicationDraft.findUnique({ where: { id: draftId } });
    if (!draft?.jobId) return 'skipped';
    await this.prepare(draft.candidateId, draft.jobId, draft.language);
    const rev = await this.drafting.currentRevision(draft.id);
    const overview = await this.overview(draft, rev?.documentIds ?? [], { schedule: false });
    if (overview.status !== 'ready') return 'skipped';
    if (overview.attachedScore !== null && overview.attachedScore >= overview.threshold) return 'ok';
    const r = await this.improve(draft.id, null);
    return r.status === 'unavailable' ? 'skipped' : 'improved';
  }

  /**
   * Gönderilen başvuruda ilana özel sürüm kullanıldıysa: açık hedef ilanlarda ana sürümle karşılaştırılır. Daha iyiyse
   * "ana yapılsın mı" diye sorulur, değilse arşivlenir.
   */
  async afterSend(attemptId: string) {
    const attempt = await this.prisma.applicationAttempt.findUnique({ where: { id: attemptId } });
    if (!attempt) return { status: 'skipped' };
    const hashes = (attempt.documentHashes as { id: string }[] | null) ?? [];
    const jobDoc = await this.prisma.documentVersion.findFirst({ where: { id: { in: hashes.map((h) => h.id) }, variant: ATS_JOB_VARIANT, archived: false, pendingPromotion: false } });
    if (!jobDoc?.content) return { status: 'skipped' };
    const main = await this.prisma.documentVersion.findFirst({ where: { candidateId: jobDoc.candidateId, type: 'cv', language: jobDoc.language, variant: ATS_MAIN_VARIANT, archived: false }, orderBy: { createdAt: 'desc' } });
    const candidate = await this.prisma.candidateProfile.findUnique({ where: { id: jobDoc.candidateId }, select: { experienceYears: true } });
    const jobs = await this.prisma.job.findMany({
      where: { workspaceId: jobDoc.workspaceId, status: 'open', atsProfile: { not: Prisma.DbNull }, id: { not: jobDoc.targetJobId ?? '' }, opportunities: { some: { category: { in: ['target_open', 'adjacent_open'] }, status: { notIn: ['dismissed', 'applied'] } } } },
      orderBy: { lastSeenAt: 'desc' },
      take: PROMOTION_SAMPLE,
      select: { id: true, atsProfile: true },
    });
    const years = candidate?.experienceYears ?? null;
    const average = (cv: StructuredCv) => (jobs.length ? jobs.reduce((sum, j) => sum + atsScore(cv, j.atsProfile as unknown as AtsProfile, years).score, 0) / jobs.length : 0);
    const mine = average(jobDoc.content as unknown as StructuredCv);
    const theirs = main?.content ? average(main.content as unknown as StructuredCv) : 0;
    if (jobs.length && mine >= theirs + PROMOTION_MARGIN) {
      await this.prisma.documentVersion.update({ where: { id: jobDoc.id }, data: { pendingPromotion: true } });
      await this.outbox.emit({
        workspaceId: jobDoc.workspaceId,
        eventType: 'notify',
        aggregateId: jobDoc.id,
        dedupKey: `ats-promotion:${jobDoc.id}`,
        payload: { type: 'ats_promotion', title: 'İlana özel CV diğer ilanlarda da daha iyi', body: `"${jobDoc.label}" açık ilanlarında ortalama %${Math.round(mine)} uyumlu; ana ATS CV %${Math.round(theirs)}. Ana CV yapılsın mı?`, link: '/profile' },
      });
      return { status: 'promotion_suggested', mine, theirs };
    }
    await this.prisma.documentVersion.update({ where: { id: jobDoc.id }, data: { archived: true } });
    return { status: 'archived', mine, theirs };
  }

  /** İlana özel sürümü ana ATS sürümü yapar; dildeki eski ana sürüm arşivlenir. */
  async promote(workspaceId: string, documentId: string) {
    const doc = await this.prisma.documentVersion.findFirst({ where: { id: documentId, workspaceId, type: 'cv', variant: { in: [ATS_JOB_VARIANT, ATS_MAIN_VARIANT] } } });
    if (!doc) throw notFound('ATS CV');
    await this.prisma.$transaction([
      this.prisma.documentVersion.updateMany({ where: { candidateId: doc.candidateId, type: 'cv', language: doc.language, variant: ATS_MAIN_VARIANT, archived: false, id: { not: doc.id } }, data: { archived: true } }),
      this.prisma.documentVersion.update({ where: { id: doc.id }, data: { variant: ATS_MAIN_VARIANT, targetJobId: null, pendingPromotion: false, archived: false, label: `CV ${doc.language.toUpperCase()} — ATS` } }),
    ]);
    return { ok: true };
  }

  /** Bekleyen terfiyi reddeder ya da ATS sürümünü temizler (arşivler; gönderilmiş başvurular etkilenmez). */
  async discard(workspaceId: string, documentId: string) {
    const doc = await this.prisma.documentVersion.findFirst({ where: { id: documentId, workspaceId, variant: { in: [ATS_JOB_VARIANT, ATS_MAIN_VARIANT] } } });
    if (!doc) throw notFound('ATS CV');
    await this.prisma.documentVersion.update({ where: { id: doc.id }, data: { archived: true, pendingPromotion: false } });
    return { ok: true };
  }

  /** Profildeki ATS sürümleri listesi: ana sürümler ve ilana özel sürümler (hangi ilan için olduğu ile). */
  async documents(workspaceId: string) {
    const docs = await this.prisma.documentVersion.findMany({
      where: { workspaceId, type: 'cv', archived: false, variant: { in: [ATS_MAIN_VARIANT, ATS_JOB_VARIANT] } },
      orderBy: [{ language: 'desc' }, { variant: 'asc' }, { createdAt: 'desc' }],
      select: { id: true, label: true, fileName: true, language: true, variant: true, targetJobId: true, pendingPromotion: true, addedSkills: true, createdAt: true, size: true },
    });
    const jobIds = docs.map((d) => d.targetJobId).filter((id): id is string => !!id);
    const jobs = jobIds.length ? await this.prisma.job.findMany({ where: { id: { in: jobIds } }, select: { id: true, title: true, company: { select: { name: true } } } }) : [];
    const jobOf = new Map(jobs.map((j) => [j.id, `${j.company.name} — ${j.title}`]));
    return docs.map(({ targetJobId, ...d }) => ({ ...d, job: targetJobId ? (jobOf.get(targetJobId) ?? null) : null }));
  }

  /** Gönderilmeden kalmış eski ilana özel sürümler temizlenir. */
  async cleanup(now = new Date()) {
    const before = new Date(now.getTime() - STALE_JOB_VARIANT_DAYS * 86400_000);
    const stale = await this.prisma.documentVersion.findMany({ where: { variant: ATS_JOB_VARIANT, archived: false, pendingPromotion: false, createdAt: { lt: before } }, select: { id: true } });
    if (!stale.length) return { archived: 0 };
    const { count } = await this.prisma.documentVersion.updateMany({ where: { id: { in: stale.map((d) => d.id) } }, data: { archived: true } });
    return { archived: count };
  }
}

function hasDescription(job: Pick<Job, 'description'>) {
  return (job.description ?? '').trim().length >= MIN_DESCRIPTION_LENGTH;
}
