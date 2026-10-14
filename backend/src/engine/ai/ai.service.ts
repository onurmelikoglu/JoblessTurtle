import { Injectable, Logger } from '@nestjs/common';
import { AiTask, Prisma } from '@prisma/client';
import { hashObject } from '../../common/crypto';
import { AppError, notFound } from '../../common/errors';
import { OutboxService } from '../../common/outbox.service';
import { PrismaService } from '../../common/prisma.service';
import { UsageService } from '../../common/usage.service';
import { AI_CLASS_LABELS, AI_CLASSES, AiClass, aiClassOf, budgetBlock, classUsageKey, dailyCeiling, dailyShare, utilizationAllows, utilizationOpensAt, UtilizationWindow } from '../../domain/ai-budget';
import { currentAiClass, noteAiCall } from './ai-context';
import { buildPrompt } from './prompts';
import { PROVIDER_LABELS, ProviderFile, ProviderLimitError, ProviderName, ProviderUsage, TEXT_PROVIDERS, WEB_RESEARCH_KINDS } from './providers';
import { AiKind, extractJson } from './schemas';
import { templateOutput } from './template-provider';
import { validateAiOutput, ValidationContext } from './validate';

export interface AiSettings {
  providerOrder: ProviderName[];
  dailyTaskLimit: number;
  webResearch?: boolean;
  /** Her gün arama profillerindeki unvanlara göre yeni firma keşfi (varsayılan açık). */
  dailyDiscovery?: boolean;
  /** Günlük keşifte profil başına önerilecek en fazla firma. */
  discoveryLimit?: number;
  models?: ModelSettings;
}

export type ModelProvider = 'cli_claude' | 'cli_codex';
export type ModelSettings = Partial<Record<ModelProvider, Partial<Record<AiKind | 'default', string>>>>;

const LIGHT_KINDS: AiKind[] = ['cv_facts', 'title_expansion', 'title_analysis', 'company_contacts', 'company_sizes', 'reply_classification', 'inbound_review', 'job_alert'];

export const DEFAULT_MODELS: Record<ModelProvider, Partial<Record<AiKind | 'default', string>>> = {
  cli_claude: { default: 'sonnet', ...Object.fromEntries(LIGHT_KINDS.map((k) => [k, 'haiku'])) },
  cli_codex: { company_contacts: 'gpt-6.1-sol' },
};

/** Bu görevlerde sağlayıcı sırasından bağımsız olarak önce denenen sağlayıcılar (ör. web'de adres aramada ChatGPT daha çok adres buluyor). */
const PREFERRED_PROVIDERS: Partial<Record<AiKind, ProviderName[]>> = { company_contacts: ['cli_codex'] };

export function providerOrderFor(kind: AiKind, order: ProviderName[]): ProviderName[] {
  const preferred = (PREFERRED_PROVIDERS[kind] ?? []).filter((p) => order.includes(p));
  return [...preferred, ...order.filter((p) => !preferred.includes(p))];
}

export function modelFor(provider: string, kind: AiKind, models?: ModelSettings): string | undefined {
  if (provider !== 'cli_claude' && provider !== 'cli_codex') return undefined;
  const custom = models?.[provider] ?? {};
  const defaults = DEFAULT_MODELS[provider];
  return custom[kind] || defaults[kind] || custom.default || defaults.default;
}

/** Çıktısı kurallara uymayan hafif model, sıradaki sağlayıcıya geçmeden önce bir kez bu modelle yeniden denenir. */
const ESCALATION_MODEL: Record<ModelProvider, Record<string, string>> = { cli_claude: { haiku: 'sonnet' }, cli_codex: {} };

export function escalationModelFor(provider: string, model: string | undefined): string | undefined {
  if (provider !== 'cli_claude' && provider !== 'cli_codex') return undefined;
  return model ? ESCALATION_MODEL[provider][model] : undefined;
}

const AI_USAGE_KEY = 'ai:tasks';
/** Worker'ın düzenli durum kaydı; yapay zekâ işleri worker'da çalıştığı için hangi sağlayıcının kurulu olduğu buradan okunur. */
export const WORKER_HEARTBEAT_KEY = 'worker:heartbeat';
const PROVIDER_COOLDOWN_MS = 60 * 60_000;
export const LIMIT_SWITCH_UTILIZATION = 0.9;
const limitsKey = (provider: string) => `provider:limits:${provider}`;
const cooldownKey = (provider: string) => `provider:cooldown:${provider}`;

export interface AiRunRequest {
  workspaceId: string;
  kind: AiKind;
  input: any;
  validation?: ValidationContext;
  entityType?: string;
  entityId?: string;
  createdById?: string | null;
  /** İşlem tamamlanınca çalışacak devam olayı (ör. taslak oluşturma) için bağlam. */
  context?: Record<string, unknown>;
  /** Otomasyon gibi kullanıcı beklenemeyen akışlarda manuel köprü atlanır. */
  allowManual?: boolean;
  /** Şablon yedeği anlamsız olan görevlerde (ör. firma keşfi) gerçek sağlayıcı yoksa görev açılmaz. */
  allowTemplate?: boolean;
  /** Önbellekteki başarılı sonucu yeniden kullan. */
  useCache?: boolean;
  files?: ProviderFile[];
  /** Bu çağrıda sağlayıcı bazında model seçimini geçersiz kılar (ör. sonuçsuz kalan aramayı daha güçlü modelle tekrarlamak). */
  modelOverride?: Partial<Record<ModelProvider, string>>;
  /** Yalnızca bu sağlayıcılar denenir (ör. farklı bir arama motoruyla ikinci görüş almak için). */
  onlyProviders?: ProviderName[];
}

export type AiRunResult =
  | { status: 'succeeded'; output: any; provider: ProviderName; taskId: string; cached: boolean }
  | { status: 'awaiting_user'; taskId: string; provider: 'manual' }
  | { status: 'unavailable'; taskId: null; provider: null };

export interface AiClassStatus {
  aiClass: AiClass;
  label: string;
  used: number;
  /** Sınıfın bugün kullanabileceği en fazla görev. */
  share: number;
  open: boolean;
  /** daily: günün hakkı bu sınıf için doldu · share: sınıfın payı doldu · subscription: abonelik limitine yaklaşıldı. */
  blockedBy: 'daily' | 'share' | 'subscription' | null;
  opensAt: Date | null;
}

export interface ServerSettings {
  shareCliWithInvitees: boolean;
  inviteeDailyLimit: number;
}

export const INVITEE_DISCOVERY_LIMIT = 10;

export const SERVER_SETTINGS_KEY = 'server:settings';
export const DEFAULT_SERVER_SETTINGS: ServerSettings = { shareCliWithInvitees: false, inviteeDailyLimit: 60 };

/** Cevapta JSON yoksa çıktı şema doğrulamasında reddedilir; böylece güçlü modelle yeniden deneme devreye girer. */
function jsonOrNull(text: string): unknown {
  try {
    return extractJson(text);
  } catch {
    return null;
  }
}

function usageColumns(usage: ProviderUsage | undefined, durationMs: number, model: string | undefined) {
  return {
    model: usage?.model ?? model ?? null,
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    cacheReadTokens: usage?.cacheReadTokens ?? null,
    cacheWriteTokens: usage?.cacheWriteTokens ?? null,
    costUsd: usage?.costUsd ?? null,
    durationMs,
  };
}

export const DEFAULT_AI_SETTINGS: AiSettings = { providerOrder: ['manual', 'template'], dailyTaskLimit: 60, webResearch: true, dailyDiscovery: true, discoveryLimit: 10 };

@Injectable()
export class AiService {
  private readonly logger = new Logger('AI');

  constructor(
    private readonly prisma: PrismaService,
    private readonly usage: UsageService,
    private readonly outbox: OutboxService,
  ) {}

  async settings(workspaceId: string): Promise<AiSettings & { ownerIsAdmin: boolean; cliAllowed: boolean; maxDailyTaskLimit: number | null }> {
    const ws = await this.prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
    const owner = await this.prisma.user.findUnique({ where: { id: ws.ownerId } });
    const ownerIsAdmin = !!owner?.isAdmin;
    const server = ownerIsAdmin ? null : await this.serverSettings();
    const cliAllowed = ownerIsAdmin || server!.shareCliWithInvitees;
    const stored = (ws.aiSettings ?? {}) as Partial<AiSettings>;
    const s = { ...DEFAULT_AI_SETTINGS, ...stored };
    if (server) {
      s.dailyTaskLimit = server.inviteeDailyLimit;
      s.discoveryLimit = Math.min(s.discoveryLimit ?? INVITEE_DISCOVERY_LIMIT, INVITEE_DISCOVERY_LIMIT);
      s.models = undefined;
    }
    const defaultOrders = [DEFAULT_AI_SETTINGS.providerOrder.join(), ['cli_claude', ...DEFAULT_AI_SETTINGS.providerOrder].join()];
    const usesDefaultOrder = !stored.providerOrder || defaultOrders.includes(stored.providerOrder.join());
    if (usesDefaultOrder && cliAllowed) s.providerOrder = ['cli_claude', 'cli_codex', ...DEFAULT_AI_SETTINGS.providerOrder];
    if (!s.providerOrder.includes('template')) s.providerOrder = [...s.providerOrder, 'template'];
    return { ...s, ownerIsAdmin, cliAllowed, maxDailyTaskLimit: server?.inviteeDailyLimit ?? null };
  }

  async inCooldown(provider: string) {
    const kv = await this.prisma.keyValue.findUnique({ where: { key: cooldownKey(provider) } });
    const until = (kv?.value as { until?: string } | null)?.until;
    return !!until && new Date(until).getTime() > Date.now();
  }

  async startCooldown(provider: string, resetAt: Date | null, reason: 'limit' | 'near_limit' = 'limit') {
    const until = resetAt && resetAt.getTime() > Date.now() ? resetAt : new Date(Date.now() + PROVIDER_COOLDOWN_MS);
    const value = { until: until.toISOString(), reason };
    await this.prisma.keyValue.upsert({ where: { key: cooldownKey(provider) }, create: { key: cooldownKey(provider), value }, update: { value } });
    this.logger.warn(`${provider} ${reason === 'near_limit' ? 'limite yaklaştığı' : 'limit nedeniyle'} için ${until.toISOString()} tarihine kadar beklemeye alındı`);
  }

  /** Aboneliğin kalan payı %10'un altına inince (kullanım ≥ %90) sağlayıcı, pencerenin sıfırlanmasına kadar bekletilir; sıradaki sağlayıcı devralır. */
  async noteLimits(provider: string, windows: { name: string; utilization: number; resetsAt: Date }[]) {
    const value = { at: new Date().toISOString(), windows: windows.map((w) => ({ name: w.name, utilization: w.utilization, resetsAt: w.resetsAt.toISOString() })) };
    await this.prisma.keyValue.upsert({ where: { key: limitsKey(provider) }, create: { key: limitsKey(provider), value }, update: { value } });
    const hot = windows.filter((w) => w.utilization >= LIMIT_SWITCH_UTILIZATION && w.resetsAt.getTime() > Date.now());
    if (!hot.length) return;
    const until = new Date(Math.max(...hot.map((w) => w.resetsAt.getTime())));
    await this.startCooldown(provider, until, 'near_limit');
  }

  async limitUsage() {
    const rows = await this.prisma.keyValue.findMany({ where: { key: { startsWith: 'provider:limits:' } } });
    return Object.fromEntries(rows.map((r) => [r.key.replace('provider:limits:', ''), r.value]));
  }

  async cooldowns() {
    const rows = await this.prisma.keyValue.findMany({ where: { key: { startsWith: 'provider:cooldown:' } } });
    return Object.fromEntries(
      rows
        .map((r) => [r.key.replace('provider:cooldown:', ''), (r.value as { until?: string }).until] as const)
        .filter(([, until]) => until && new Date(until).getTime() > Date.now()),
    );
  }

  private async limitWindows(provider: string): Promise<UtilizationWindow[]> {
    const kv = await this.prisma.keyValue.findUnique({ where: { key: limitsKey(provider) } });
    return ((kv?.value as { windows?: UtilizationWindow[] } | null)?.windows ?? []) as UtilizationWindow[];
  }

  /** Gerçek (abonelik ya da API ile çalışan) sağlayıcılardan bu çalışma alanının kullanabildikleri, tercih sırasıyla. */
  private realProviders(settings: { providerOrder: ProviderName[]; cliAllowed: boolean }): ProviderName[] {
    return settings.providerOrder.filter((name) => !!TEXT_PROVIDERS[name] && (!TEXT_PROVIDERS[name].ownerOnly || settings.cliAllowed));
  }

  /**
   * Öncelik sınıflarının bugünkü durumu. Sınıf, günlük hakkı ya da payı dolduğunda ve kullanabildiği her sağlayıcı
   * beklemede ya da sınıfın kullanım tavanının üstünde olduğunda kapanır. Gerçek sağlayıcısı olmayan (elle ya da
   * şablonla çalışan) çalışma alanında yalnızca günlük hak sınırlar. local: sağlayıcının kurulu olup olmadığına bu
   * süreçte bakılır (worker); aksi halde worker'ın son bildirdiği durum kullanılır.
   */
  async classStatus(workspaceId: string, opts: { local?: boolean } = {}): Promise<AiClassStatus[]> {
    const settings = await this.settings(workspaceId);
    const usedTotal = await this.usage.get(workspaceId, AI_USAGE_KEY);
    const now = Date.now();
    const cooldowns = await this.cooldowns();
    const windows = new Map<string, UtilizationWindow[]>();
    const usable = await this.installed(this.realProviders(settings), opts.local === true);
    for (const name of usable) windows.set(name, await this.limitWindows(name));
    const out: AiClassStatus[] = [];
    for (const aiClass of AI_CLASSES) {
      const used = await this.usage.get(workspaceId, classUsageKey(aiClass));
      const budget = budgetBlock(aiClass, { dailyLimit: settings.dailyTaskLimit, usedTotal, usedByClass: used });
      const free = usable.filter((name) => !cooldowns[name] && utilizationAllows(aiClass, windows.get(name), now));
      const subscriptionBlocked = usable.length > 0 && free.length === 0;
      const reopenings = usable.map((name) => (cooldowns[name] ? new Date(cooldowns[name]!) : utilizationOpensAt(aiClass, windows.get(name), now))).filter((d): d is Date => !!d);
      out.push({
        aiClass,
        label: AI_CLASS_LABELS[aiClass],
        used,
        share: dailyShare(aiClass, settings.dailyTaskLimit),
        open: !budget && !subscriptionBlocked,
        blockedBy: budget ?? (subscriptionBlocked ? 'subscription' : null),
        opensAt: !budget && subscriptionBlocked && reopenings.length ? new Date(Math.min(...reopenings.map((d) => d.getTime()))) : null,
      });
    }
    return out;
  }

  /** Arka plan işi başlamadan sorulur: sınıf kapalıysa iş, şablon ya da elle tamamlanacak görev üretmeden ertelenir. */
  async classOpen(workspaceId: string, aiClass: AiClass): Promise<boolean> {
    return (await this.classStatus(workspaceId, { local: true })).find((c) => c.aiClass === aiClass)?.open ?? true;
  }

  async installedProviders(): Promise<Record<string, boolean>> {
    const entries = await Promise.all(Object.entries(TEXT_PROVIDERS).map(async ([name, provider]) => [name, (await provider.available()).ok] as const));
    return Object.fromEntries(entries);
  }

  private async installed(names: ProviderName[], local: boolean): Promise<ProviderName[]> {
    if (!names.length) return names;
    const kv = local ? null : await this.prisma.keyValue.findUnique({ where: { key: WORKER_HEARTBEAT_KEY } });
    const known = local ? await this.installedProviders() : (kv?.value as { providers?: Record<string, boolean> } | null)?.providers;
    return known ? names.filter((name) => known[name] === true) : names;
  }

  private async reserveBudget(workspaceId: string, aiClass: AiClass, dailyLimit: number): Promise<boolean> {
    if (!(await this.usage.reserve(workspaceId, classUsageKey(aiClass), dailyShare(aiClass, dailyLimit)))) return false;
    if (await this.usage.reserve(workspaceId, AI_USAGE_KEY, dailyCeiling(aiClass, dailyLimit))) return true;
    await this.usage.release(workspaceId, classUsageKey(aiClass));
    return false;
  }

  async cliSharedWithInvitees(): Promise<boolean> {
    const kv = await this.prisma.keyValue.findUnique({ where: { key: SERVER_SETTINGS_KEY } });
    return (kv?.value as ServerSettings | null)?.shareCliWithInvitees === true;
  }

  async serverSettings(): Promise<ServerSettings> {
    const kv = await this.prisma.keyValue.findUnique({ where: { key: SERVER_SETTINGS_KEY } });
    return { ...DEFAULT_SERVER_SETTINGS, ...((kv?.value ?? {}) as Partial<ServerSettings>) };
  }

  async updateServerSettings(patch: Partial<ServerSettings>): Promise<ServerSettings> {
    const next = { ...(await this.serverSettings()), ...patch };
    await this.prisma.keyValue.upsert({ where: { key: SERVER_SETTINGS_KEY }, create: { key: SERVER_SETTINGS_KEY, value: next as unknown as Prisma.InputJsonValue }, update: { value: next as unknown as Prisma.InputJsonValue } });
    return next;
  }

  async providerStatus(workspaceId: string) {
    const s = await this.settings(workspaceId);
    const out = [];
    for (const name of Object.keys(PROVIDER_LABELS) as ProviderName[]) {
      const p = TEXT_PROVIDERS[name];
      const availability = p ? await p.available() : { ok: true, detail: name === 'manual' ? 'Her zaman kullanılabilir' : 'Her zaman kullanılabilir' };
      const allowed = !p?.ownerOnly || s.cliAllowed;
      out.push({
        name,
        label: PROVIDER_LABELS[name],
        available: availability.ok,
        detail: availability.detail,
        allowed,
        allowedReason: allowed ? null : 'Kişisel abonelikle çalışan CLI yalnızca sunucu sahibinin çalışma alanında veya yönetici paylaşımı açtığında kullanılabilir',
        enabled: s.providerOrder.includes(name),
        order: s.providerOrder.indexOf(name),
      });
    }
    return { settings: s, providers: out };
  }

  async updateSettings(workspaceId: string, patch: Partial<AiSettings>) {
    const current = await this.settings(workspaceId);
    const order = (patch.providerOrder ?? current.providerOrder).filter((p, i, arr) => arr.indexOf(p) === i && p in PROVIDER_LABELS);
    for (const name of order) {
      if (TEXT_PROVIDERS[name]?.ownerOnly && !current.cliAllowed)
        throw new AppError(403, 'PROVIDER_NOT_ALLOWED', `${PROVIDER_LABELS[name]} yalnızca sunucu sahibinin çalışma alanında kullanılabilir`);
    }
    const next = {
      providerOrder: order,
      dailyTaskLimit: patch.dailyTaskLimit ?? current.dailyTaskLimit,
      webResearch: patch.webResearch ?? current.webResearch,
      dailyDiscovery: patch.dailyDiscovery ?? current.dailyDiscovery,
      discoveryLimit: patch.discoveryLimit ?? current.discoveryLimit,
      models: current.ownerIsAdmin ? (patch.models ?? current.models) : undefined,
    };
    await this.prisma.workspace.update({ where: { id: workspaceId }, data: { aiSettings: next as Prisma.InputJsonValue } });
    return this.providerStatus(workspaceId);
  }

  async run(req: AiRunRequest): Promise<AiRunResult> {
    const settings = await this.settings(req.workspaceId);
    const webResearch = WEB_RESEARCH_KINDS.includes(req.kind) && settings.webResearch !== false;
    const input = { ...req.input, webResearch };
    const prompt = buildPrompt(req.kind, input);
    const inputHash = hashObject({ kind: req.kind, input, prompt });
    const validation = { ...req.validation, allowWebRefs: webResearch };
    const aiClass = currentAiClass() ?? aiClassOf(req.kind);

    if (req.useCache !== false) {
      const cached = await this.prisma.aiTask.findFirst({
        where: { workspaceId: req.workspaceId, kind: req.kind, inputHash, status: 'succeeded' },
        orderBy: { createdAt: 'desc' },
      });
      if (cached) return { status: 'succeeded', output: cached.output, provider: cached.provider as ProviderName, taskId: cached.id, cached: true };
    }

    const base = {
      workspaceId: req.workspaceId,
      kind: req.kind,
      inputHash,
      prompt,
      input: input as Prisma.InputJsonValue,
      entityType: req.entityType ?? null,
      entityId: req.entityId ?? null,
      createdById: req.createdById ?? null,
      context: { ...(req.context ?? {}), validation, aiClass } as Prisma.InputJsonValue,
    };

    for (const name of providerOrderFor(req.kind, settings.providerOrder)) {
      if (name === 'template') break;
      if (req.onlyProviders && !req.onlyProviders.includes(name)) continue;
      if (name === 'manual') {
        if (req.allowManual === false) continue;
        const existing = await this.prisma.aiTask.findFirst({ where: { workspaceId: req.workspaceId, kind: req.kind, inputHash, status: 'awaiting_user' } });
        if (existing) return { status: 'awaiting_user', taskId: existing.id, provider: 'manual' };
        const task = await this.prisma.aiTask.create({ data: { ...base, provider: 'manual', status: 'awaiting_user' } });
        await this.outbox.emit({
          workspaceId: req.workspaceId,
          eventType: 'notify',
          aggregateId: task.id,
          dedupKey: `ai-waiting:${task.id}`,
          payload: { type: 'ai_task_waiting', title: 'AI görevi sizi bekliyor', body: 'İstemi Claude veya ChatGPT sohbetine yapıştırıp cevabı uygulamaya geri yapıştırın.', link: `/ai?task=${task.id}` },
        });
        return { status: 'awaiting_user', taskId: task.id, provider: 'manual' };
      }
      const provider = TEXT_PROVIDERS[name];
      if (!provider) continue;
      if (req.files?.length && name !== 'cli_claude' && name !== 'cli_codex') continue;
      if (provider.ownerOnly && !settings.cliAllowed) continue;
      if (await this.inCooldown(name)) continue;
      if (!utilizationAllows(aiClass, await this.limitWindows(name))) continue;
      if (!(await provider.available()).ok) continue;
      const firstModel = req.modelOverride?.[name as ModelProvider] ?? modelFor(name, req.kind, settings.models);
      const models = [firstModel, ...(req.modelOverride?.[name as ModelProvider] ? [] : [escalationModelFor(name, firstModel)])].filter((m, i) => i === 0 || !!m);
      let budgetExhausted = false;
      for (const model of models) {
        if (!(await this.reserveBudget(req.workspaceId, aiClass, settings.dailyTaskLimit))) {
          this.logger.warn(`AI günlük hakkı doldu (${req.workspaceId}, ${aiClass}); şablon moduna geçiliyor`);
          budgetExhausted = true;
          break;
        }
        const task = await this.prisma.aiTask.create({ data: { ...base, provider: name, status: 'running', attempts: 1, model: model ?? null } });
        noteAiCall();
        const started = Date.now();
        try {
          const result = await provider.complete(prompt, { kind: req.kind, webResearch, files: req.files, model });
          const text = result.text;
          const usageData = usageColumns(result.usage, Date.now() - started, model);
          if (result.limits?.length) await this.noteLimits(name, result.limits).catch((e) => this.logger.warn(`Limit bilgisi kaydedilemedi: ${(e as Error).message}`));
          const v = validateAiOutput(req.kind, jsonOrNull(text), validation);
          if (!v.ok) {
            await this.prisma.aiTask.update({ where: { id: task.id }, data: { status: 'rejected', rawOutput: text.slice(0, 20000), error: v.problems.join('; '), ...usageData } });
            this.logger.warn(`${name} (${model ?? 'varsayılan model'}) çıktısı reddedildi: ${v.problems.join('; ')}`);
            continue;
          }
          await this.prisma.aiTask.update({
            where: { id: task.id },
            data: { status: 'succeeded', output: v.output as Prisma.InputJsonValue, rawOutput: text.slice(0, 20000), completedAt: new Date(), ...usageData },
          });
          await this.prisma.aiTask.updateMany({ where: { workspaceId: req.workspaceId, kind: req.kind, inputHash, status: 'awaiting_user' }, data: { status: 'cancelled', error: `${PROVIDER_LABELS[name]} ile otomatik tamamlandı` } });
          return { status: 'succeeded', output: v.output, provider: name, taskId: task.id, cached: false };
        } catch (e) {
          await this.prisma.aiTask.update({ where: { id: task.id }, data: { status: 'failed', error: (e as Error).message.slice(0, 1000), durationMs: Date.now() - started } });
          if (e instanceof ProviderLimitError) await this.startCooldown(name, e.resetAt);
          this.logger.warn(`${name} başarısız: ${(e as Error).message}`);
          break;
        }
      }
      if (budgetExhausted) break;
    }

    if (req.allowTemplate === false) return { status: 'unavailable', taskId: null, provider: null };
    const output = templateOutput(req.kind, input);
    const v = validateAiOutput(req.kind, output, validation);
    const task = await this.prisma.aiTask.create({
      data: { ...base, provider: 'template', status: 'succeeded', output: (v.output ?? output) as Prisma.InputJsonValue, completedAt: new Date(), error: v.ok ? null : v.problems.join('; ') },
    });
    return { status: 'succeeded', output: v.output ?? output, provider: 'template', taskId: task.id, cached: false };
  }

  /** Manuel köprü: kullanıcı sohbetten aldığı cevabı yapıştırır; doğrulanırsa iş akışı devam eder. */
  async submitManual(workspaceId: string, taskId: string, rawText: string): Promise<AiTask> {
    const task = await this.prisma.aiTask.findFirst({ where: { id: taskId, workspaceId } });
    if (!task) throw notFound('AI görevi');
    if (task.status !== 'awaiting_user') throw new AppError(409, 'TASK_NOT_WAITING', 'Bu görev cevap beklemiyor');
    let parsed: unknown;
    try {
      parsed = extractJson(rawText);
    } catch {
      throw new AppError(422, 'AI_OUTPUT_NOT_JSON', 'Yapıştırılan metinde geçerli JSON bulunamadı. Sohbetten yalnızca JSON cevabını kopyalayın.');
    }
    const ctx = ((task.context ?? {}) as any).validation as ValidationContext | undefined;
    const v = validateAiOutput(task.kind as AiKind, parsed, { ...(ctx ?? {}), allowWebRefs: true });
    if (!v.ok) throw new AppError(422, 'AI_OUTPUT_INVALID', 'Cevap kurallara uymuyor', v.problems);
    const updated = await this.prisma.$transaction(async (tx) => {
      const t = await tx.aiTask.update({
        where: { id: taskId },
        data: { status: 'succeeded', output: v.output as Prisma.InputJsonValue, rawOutput: rawText.slice(0, 20000), completedAt: new Date() },
      });
      await this.outbox.emit({ workspaceId, eventType: 'ai.task.completed', aggregateId: taskId, dedupKey: `ai-done:${taskId}`, payload: { taskId } }, tx);
      return t;
    });
    return updated;
  }

  async cancel(workspaceId: string, taskId: string) {
    const task = await this.prisma.aiTask.findFirst({ where: { id: taskId, workspaceId } });
    if (!task) throw notFound('AI görevi');
    return this.prisma.aiTask.update({ where: { id: taskId }, data: { status: 'cancelled' } });
  }

  /** Manuel görevi şablon çıktısıyla tamamlar (kullanıcı AI kullanmadan devam etmek isterse). */
  async completeWithTemplate(workspaceId: string, taskId: string) {
    const task = await this.prisma.aiTask.findFirst({ where: { id: taskId, workspaceId } });
    if (!task) throw notFound('AI görevi');
    if (task.status !== 'awaiting_user') throw new AppError(409, 'TASK_NOT_WAITING', 'Bu görev cevap beklemiyor');
    const output = templateOutput(task.kind as AiKind, task.input);
    return this.prisma.$transaction(async (tx) => {
      const t = await tx.aiTask.update({ where: { id: taskId }, data: { status: 'succeeded', provider: 'template', output: output as Prisma.InputJsonValue, completedAt: new Date() } });
      await this.outbox.emit({ workspaceId, eventType: 'ai.task.completed', aggregateId: taskId, dedupKey: `ai-done:${taskId}`, payload: { taskId } }, tx);
      return t;
    });
  }
}
