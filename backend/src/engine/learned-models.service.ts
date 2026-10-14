import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { istanbulNow } from '../common/time';
import { LearnedModelSummary, LearningOverview, PromptVariant, WeeklyDelivery } from '../contracts/learning';
import { ServerShape } from '../contracts/wire';
import { addressFeatures, AddressFeatures } from '../domain/address-book';
import { RecipientDelivery } from '../domain/contacts';
import { SendOutcome } from '../domain/learning';
import {
  contactSearchHints,
  deliveryFeatures,
  deliveryLabel,
  discoveryHints,
  InterestContext,
  interestFeatures,
  LEARNED_MODEL_LABELS,
  LearnedModelName,
  ReplyContext,
  replyFeatures,
  replyLabel,
} from '../domain/learning-features';
import { fitModel, predict, Sample, TrainedModel } from '../domain/learning-model';

const MODEL_PREFIX = 'learning:model:';
const HINTS_KEY = 'learning:hints';
const DISCOVERY_HINTS_PREFIX = 'learning:hints:discovery:';
const TRAINED_KEY = 'learning:trained';
const CACHE_MS = 5 * 60_000;
const DAY_MS = 86_400_000;
/** Daha önce mail ulaştığı görülen adres için kestirim yerine bilinen sonuç kullanılır. */
const KNOWN_DELIVERABLE = 0.98;
const DELIVERY_VERIFIED_BY = 'delivery';
const WEEKS_SHOWN = 10;
const SUMMARY_EFFECTS = 8;
const PROVEN_EXAMPLES = 2;
const PROVEN_REPLY_CATEGORIES = ['human_reply', 'interview'];
const USER_SEND_MODES = ['manual', 'campaign'];
const EXPORT_LIMIT = 5000;
const EVENT_LABELS: Record<string, string> = { send: 'Gönderim', contact_search: 'Adres araması', discovery: 'Firma keşfi', size_search: 'Çalışan sayısı araması', job_search: 'İlan araması' };
const VARIANT_SUCCESS: Record<string, { label: string; field: string }> = {
  contact_search: { label: 'Adres araması (yeni gönderilebilir adres bulundu)', field: 'added' },
  discovery: { label: 'Firma keşfi (yeni firma eklendi)', field: 'created' },
};
/** Dışa aktarımda kaydın kalitesini belirleyen sonuç alanı: sıfırdan büyükse iş işe yaramıştır. */
const EXPORT_SUCCESS_FIELD: Record<string, string> = { contact_search: 'added', discovery: 'created', size_search: 'found', job_search: 'fresh' };

type SendFeatures = Partial<AddressFeatures> & ReplyContext & Record<string, unknown>;
type ContactLike = { email: string; kind: string; sourceUrl?: string | null; verifiedAt?: Date | null; verifiedBy?: string | null };
type CompanyLike = { canonicalDomain: string | null; aliases?: string[] };

/**
 * Öğrenen sistem: deneyim defterinden (LearningEvent) hafif modeller eğitir, sonuçlarını alıcı sıralamasına, fırsat
 * sıralamasına ve yapay zekâ istemlerine taşır. Etkin olmayan model hiçbir kararı değiştirmez; bu durumda sistem
 * model öncesindeki davranışıyla aynen çalışır.
 */
@Injectable()
export class LearnedModelsService {
  private readonly logger = new Logger('Learning');
  private readonly cache = new Map<string, { at: number; value: unknown }>();

  constructor(private readonly prisma: PrismaService) {}

  private async stored<T>(key: string): Promise<T | null> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as T | null;
    const kv = await this.prisma.keyValue.findUnique({ where: { key } });
    const value = (kv?.value ?? null) as T | null;
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  private async store(key: string, value: unknown) {
    const json = value as Prisma.InputJsonValue;
    await this.prisma.keyValue.upsert({ where: { key }, create: { key, value: json }, update: { value: json } });
    this.cache.set(key, { at: Date.now(), value });
  }

  private model(name: LearnedModelName, workspaceId?: string) {
    return this.stored<TrainedModel>(`${MODEL_PREFIX}${name}${workspaceId ? `:${workspaceId}` : ''}`);
  }

  // ───────────── Eğitim ─────────────

  /** Tüm modelleri ve istem ipuçlarını yeniden hesaplar. Veri küçük olduğu için her gece baştan eğitilir. */
  async train(now = new Date()) {
    const sends = await this.prisma.learningEvent.findMany({ where: { kind: 'send', resolvedAt: { not: null } }, select: { id: true, workspaceId: true, companyId: true, features: true, outcome: true, createdAt: true } });
    const deliverySamples: Sample[] = [];
    const replySamples: Sample[] = [];
    for (const event of sends) {
      const features = (event.features ?? {}) as SendFeatures;
      const outcome = event.outcome as SendOutcome | null;
      const delivered = deliveryLabel(outcome);
      if (delivered !== null && features.kind && features.local && features.sourceType) deliverySamples.push({ key: event.id, features: deliveryFeatures(features as AddressFeatures), label: delivered });
      const replied = replyLabel(outcome, (now.getTime() - event.createdAt.getTime()) / DAY_MS);
      if (replied !== null) replySamples.push({ key: event.id, features: replyFeatures(features), label: replied });
    }
    const trained: TrainedModel[] = [fitModel('delivery', deliverySamples, undefined, now), fitModel('reply', replySamples, undefined, now)];
    await this.store(`${MODEL_PREFIX}delivery`, trained[0]);
    await this.store(`${MODEL_PREFIX}reply`, trained[1]);
    await this.store(HINTS_KEY, { contactSearch: contactSearchHints(deliverySamples) });

    for (const workspace of await this.prisma.workspace.findMany({ select: { id: true } })) {
      const interest = fitModel('interest', await this.interestSamples(workspace.id), undefined, now);
      await this.store(`${MODEL_PREFIX}interest:${workspace.id}`, interest);
      trained.push(interest);
      const repliedCompanyIds = [...new Set(sends.filter((e) => e.workspaceId === workspace.id && e.companyId && (e.outcome as SendOutcome | null)?.replied).map((e) => e.companyId!))];
      const replied = repliedCompanyIds.length ? await this.prisma.company.findMany({ where: { id: { in: repliedCompanyIds } }, select: { sectors: true, employeeRange: true } }) : [];
      await this.store(`${DISCOVERY_HINTS_PREFIX}${workspace.id}`, { hints: discoveryHints(replied) });
    }
    await this.store(TRAINED_KEY, { at: now.toISOString() });
    const summary = trained.map((m) => `${m.name}:${m.metrics.samples}${m.active ? '+' : ''}`).join(' ');
    this.logger.log(`Modeller eğitildi (${summary})`);
    return { models: trained.map((m) => ({ name: m.name, active: m.active, samples: m.metrics.samples })) };
  }

  /** Kullanıcının kendi kararları: gizlediği fırsatlar olumsuz, kendisinin başvurdukları olumlu örnektir. */
  private async interestSamples(workspaceId: string): Promise<Sample[]> {
    const opportunities = await this.prisma.opportunity.findMany({
      where: { workspaceId, status: { in: ['dismissed', 'applied'] } },
      select: { id: true, status: true, category: true, titleMatch: true, locationState: true, jobId: true, company: { select: { employeeRange: true, origin: true } } },
    });
    const applied = opportunities.filter((o) => o.status === 'applied').map((o) => o.id);
    const drafts = applied.length ? await this.prisma.applicationDraft.findMany({ where: { opportunityId: { in: applied } }, select: { id: true, opportunityId: true } }) : [];
    const userSent = drafts.length ? await this.prisma.applicationAttempt.findMany({ where: { draftId: { in: drafts.map((d) => d.id) }, sendMode: { in: USER_SEND_MODES } }, select: { draftId: true } }) : [];
    const userDrafts = new Set(userSent.map((a) => a.draftId));
    const byUser = new Set(drafts.filter((d) => userDrafts.has(d.id)).map((d) => d.opportunityId));
    return opportunities
      .filter((o) => o.status === 'dismissed' || byUser.has(o.id))
      .map((o) => ({
        key: o.id,
        label: o.status === 'dismissed' ? (0 as const) : (1 as const),
        features: interestFeatures({ category: o.category, titleMatch: o.titleMatch, locationState: o.locationState, employeeRange: o.company.employeeRange, companyOrigin: o.company.origin, hasJob: !!o.jobId }),
      }));
  }

  // ───────────── Kullanım ─────────────

  /**
   * Firmanın adresleri için teslim kestirimi; model etkin değilse undefined döner ve alıcı sıralaması değişmez.
   * Daha önce ulaştığı görülen adreste kestirim yerine bilinen sonuç kullanılır.
   */
  async deliveryFor(company: CompanyLike): Promise<RecipientDelivery | undefined> {
    const model = await this.model('delivery');
    if (!model?.active) return undefined;
    return {
      baseRate: model.metrics.baseRate,
      of: (c: ContactLike) =>
        c.verifiedBy === DELIVERY_VERIFIED_BY ? KNOWN_DELIVERABLE : predict(model, deliveryFeatures(addressFeatures({ email: c.email, kind: c.kind, sourceUrl: c.sourceUrl, verified: !!c.verifiedAt }, { canonicalDomain: company.canonicalDomain, aliases: company.aliases }))),
    };
  }

  /** Fırsat sıralaması için öğrenilmiş puan: yanıt ve ilgi modellerinden etkin olanların çarpımı; hiçbiri etkin değilse null. */
  async opportunityRanker(workspaceId: string): Promise<((context: ReplyContext & InterestContext) => number) | null> {
    const [reply, interest] = await Promise.all([this.model('reply'), this.model('interest', workspaceId)]);
    const active = [reply?.active ? (c: ReplyContext & InterestContext) => predict(reply, replyFeatures(c)) : null, interest?.active ? (c: ReplyContext & InterestContext) => predict(interest, interestFeatures(c)) : null].filter(
      (f): f is (c: ReplyContext & InterestContext) => number => !!f,
    );
    return active.length ? (context) => active.reduce((score, f) => score * f(context), 1) : null;
  }

  async contactSearchHints(): Promise<string[]> {
    return (await this.stored<{ contactSearch?: string[] }>(HINTS_KEY))?.contactSearch ?? [];
  }

  async discoveryHints(workspaceId: string): Promise<string[]> {
    return (await this.stored<{ hints?: string[] }>(`${DISCOVERY_HINTS_PREFIX}${workspaceId}`))?.hints ?? [];
  }

  /** Adayın daha önce firmadan yanıt almış başvurularındaki firmaya özel paragraflar; yeni yazı için ton ve somutluk örneği. */
  async provenLetterLines(candidateId: string, excludeCompanyId: string): Promise<{ opening: string; connection: string }[]> {
    const candidate = await this.prisma.candidateProfile.findUnique({ where: { id: candidateId }, select: { workspaceId: true } });
    if (!candidate) return [];
    const replies = await this.prisma.inboundMessage.findMany({ where: { workspaceId: candidate.workspaceId, category: { in: PROVEN_REPLY_CATEGORIES }, attemptId: { not: null } }, orderBy: { receivedAt: 'desc' }, take: 20, select: { attemptId: true } });
    if (!replies.length) return [];
    const attempts = await this.prisma.applicationAttempt.findMany({ where: { id: { in: replies.map((r) => r.attemptId!) }, candidateId, companyId: { not: excludeCompanyId } }, orderBy: { createdAt: 'desc' }, select: { companyId: true, createdAt: true } });
    const examples: { opening: string; connection: string }[] = [];
    const seen = new Set<string>();
    for (const attempt of attempts) {
      if (examples.length >= PROVEN_EXAMPLES) break;
      if (seen.has(attempt.companyId)) continue;
      seen.add(attempt.companyId);
      const task = await this.prisma.aiTask.findFirst({
        where: { workspaceId: candidate.workspaceId, kind: 'letter_company_line', entityType: 'Company', entityId: attempt.companyId, status: 'succeeded', provider: { not: 'template' }, createdAt: { lte: attempt.createdAt } },
        orderBy: { createdAt: 'desc' },
        select: { output: true },
      });
      const lines = task?.output as { opening?: string; connection?: string } | null;
      if (lines?.opening && lines.connection) examples.push({ opening: lines.opening, connection: lines.connection });
    }
    return examples;
  }

  // ───────────── Yönetici ─────────────

  async overview(): Promise<ServerShape<LearningOverview>> {
    const [counts, resolved, workspaces, trained, hints, exportable] = await Promise.all([
      this.prisma.learningEvent.groupBy({ by: ['kind'], _count: true }),
      this.prisma.learningEvent.groupBy({ by: ['kind'], where: { resolvedAt: { not: null } }, _count: true }),
      this.prisma.workspace.findMany({ select: { id: true, name: true }, orderBy: { createdAt: 'asc' } }),
      this.stored<{ at?: string }>(TRAINED_KEY),
      this.contactSearchHints(),
      this.prisma.learningEvent.count({ where: { OR: [{ aiTaskId: { not: null } }, { kind: 'send' }] } }),
    ]);
    const resolvedOf = new Map(resolved.map((r) => [r.kind, r._count]));
    const models: ServerShape<LearnedModelSummary>[] = [];
    for (const name of ['delivery', 'reply'] as const) models.push(summaryOf(name, null, await this.model(name)));
    for (const workspace of workspaces) models.push(summaryOf('interest', workspace.name, await this.model('interest', workspace.id)));
    return {
      events: counts.map((c) => ({ kind: c.kind, label: EVENT_LABELS[c.kind] ?? c.kind, total: c._count, resolved: resolvedOf.get(c.kind) ?? 0 })).sort((a, b) => b.total - a.total),
      models,
      weekly: await this.weeklyDelivery(),
      hints: { contactSearch: hints },
      promptVariants: await this.promptVariants(),
      exportable,
      trainedAt: trained?.at ? new Date(trained.at) : null,
    };
  }

  /** Haftalara göre gönderim sonuçları: geri dönüş oranının zaman içinde düşüp düşmediği buradan izlenir. */
  private async weeklyDelivery(now = new Date()): Promise<WeeklyDelivery[]> {
    const since = istanbulNow(now).startOf('week').minus({ weeks: WEEKS_SHOWN - 1 });
    const events = await this.prisma.learningEvent.findMany({ where: { kind: 'send', createdAt: { gte: since.toJSDate() } }, select: { createdAt: true, outcome: true } });
    const weeks = new Map<string, WeeklyDelivery>();
    for (const event of events) {
      const week = istanbulNow(event.createdAt).startOf('week').toFormat('yyyy-LL-dd');
      const row = weeks.get(week) ?? { week, sent: 0, delivered: 0, bounced: 0, replied: 0, pending: 0, bounceRate: 0 };
      const outcome = event.outcome as SendOutcome | null;
      row.sent++;
      if (outcome?.bounced) row.bounced++;
      else if (outcome?.delivered) row.delivered++;
      if (outcome?.replied) row.replied++;
      weeks.set(week, row);
    }
    return [...weeks.values()].sort((a, b) => (a.week < b.week ? -1 : 1)).map((row) => ({ ...row, pending: row.sent - row.delivered - row.bounced, bounceRate: row.bounced / row.sent }));
  }

  /** İpucu eklenmiş ve eklenmemiş istemlerin sonuçları yan yana: ipucunun işe yarayıp yaramadığı buradan görülür. */
  private async promptVariants(): Promise<PromptVariant[]> {
    const events = await this.prisma.learningEvent.findMany({ where: { kind: { in: Object.keys(VARIANT_SUCCESS) }, aiTaskId: { not: null } }, select: { kind: true, features: true, outcome: true } });
    const groups = new Map<string, { kind: string; hints: boolean; runs: number; successes: number }>();
    for (const event of events) {
      const hints = (event.features as { hints?: boolean } | null)?.hints === true;
      const key = `${event.kind}:${hints}`;
      const group = groups.get(key) ?? { kind: event.kind, hints, runs: 0, successes: 0 };
      group.runs++;
      if (Number((event.outcome as Record<string, unknown> | null)?.[VARIANT_SUCCESS[event.kind].field] ?? 0) > 0) group.successes++;
      groups.set(key, group);
    }
    return [...groups.values()].sort((a, b) => a.kind.localeCompare(b.kind) || Number(a.hints) - Number(b.hints)).map((g) => ({ kind: g.kind, label: VARIANT_SUCCESS[g.kind].label, hints: g.hints, runs: g.runs, successRate: g.successes / g.runs }));
  }

  /**
   * İnce ayara hazır veri seti (JSONL): her satır bir yapay zekâ görevinin istemi, kabul edilmiş çıktısı ve gerçek
   * dünyadaki sonucudur. Satırlar sohbet biçimindedir; quality alanı sonucu iyi olan örnekleri seçmek içindir.
   */
  async exportDataset(limit = EXPORT_LIMIT): Promise<string> {
    const events = await this.prisma.learningEvent.findMany({ where: { OR: [{ aiTaskId: { not: null } }, { kind: 'send' }] }, orderBy: { createdAt: 'desc' }, take: limit });
    const lines: string[] = [];
    for (const event of events) {
      const taskId = event.kind === 'send' ? await this.letterTaskOf(event.attemptId) : event.aiTaskId;
      if (!taskId) continue;
      const task = await this.prisma.aiTask.findUnique({ where: { id: taskId }, select: { kind: true, provider: true, model: true, prompt: true, output: true, status: true, createdAt: true } });
      if (!task || task.status !== 'succeeded' || task.output === null || task.provider === 'template') continue;
      lines.push(
        JSON.stringify({
          kind: event.kind,
          task: task.kind,
          provider: task.provider,
          model: task.model,
          createdAt: task.createdAt.toISOString(),
          quality: qualityOf(event.kind, event.outcome as Record<string, unknown> | null),
          outcome: event.outcome,
          messages: [
            { role: 'user', content: task.prompt },
            { role: 'assistant', content: JSON.stringify(task.output) },
          ],
        }),
      );
    }
    return lines.join('\n') + (lines.length ? '\n' : '');
  }

  /** Gönderilen yazıyı üreten görev: taslak sürümüne bağlı görev, yoksa firmanın gönderimden önceki son firmaya özel paragraf görevi. */
  private async letterTaskOf(attemptId: string | null): Promise<string | null> {
    const attempt = attemptId ? await this.prisma.applicationAttempt.findUnique({ where: { id: attemptId }, select: { workspaceId: true, companyId: true, draftId: true, draftRevision: true, createdAt: true } }) : null;
    if (!attempt) return null;
    const revision = await this.prisma.draftRevision.findUnique({ where: { draftId_revision: { draftId: attempt.draftId, revision: attempt.draftRevision } }, select: { aiTaskId: true } });
    if (revision?.aiTaskId) return revision.aiTaskId;
    const task = await this.prisma.aiTask.findFirst({
      where: { workspaceId: attempt.workspaceId, kind: 'letter_company_line', entityType: 'Company', entityId: attempt.companyId, status: 'succeeded', createdAt: { lte: attempt.createdAt } },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    return task?.id ?? null;
  }
}

function summaryOf(name: LearnedModelName, scope: string | null, model: TrainedModel | null): ServerShape<LearnedModelSummary> {
  return {
    name,
    label: LEARNED_MODEL_LABELS[name],
    scope,
    trainedAt: model ? new Date(model.trainedAt) : null,
    active: model?.active ?? false,
    inactiveReason: model ? model.inactiveReason : 'few_samples',
    samples: model?.metrics.samples ?? 0,
    positives: model?.metrics.positives ?? 0,
    baseRate: model?.metrics.baseRate ?? 0,
    gain: model?.metrics.gain ?? 0,
    auc: model?.metrics.auc ?? null,
    effects: (model?.effects ?? []).slice(0, SUMMARY_EFFECTS),
  };
}

function qualityOf(kind: string, outcome: Record<string, unknown> | null): 'good' | 'neutral' | 'bad' {
  if (!outcome) return 'neutral';
  if (kind === 'send') return outcome.replied ? 'good' : 'neutral';
  const field = EXPORT_SUCCESS_FIELD[kind];
  return field && Number(outcome[field] ?? 0) > 0 ? 'good' : 'bad';
}
