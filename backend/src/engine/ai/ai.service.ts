import { Injectable, Logger } from '@nestjs/common';
import { AiTask, Prisma } from '@prisma/client';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { decryptSecret, encryptSecret, hashObject } from '../../common/crypto';
import type { ApiKeyStatus } from '../../contracts/ai-setup';
import type { ServerShape } from '../../contracts/wire';
import { AppError, notFound } from '../../common/errors';
import { OutboxService } from '../../common/outbox.service';
import { PrismaService } from '../../common/prisma.service';
import { UsageService } from '../../common/usage.service';
import { AI_CLASS_LABELS, AI_CLASSES, AiClass, aiClassOf, budgetBlock, classUsageKey, dailyCeiling, dailyShare, utilizationAllows, utilizationOpensAt, UtilizationWindow } from '../../domain/ai-budget';
import { currentAiClass, noteAiCall } from './ai-context';
import { buildPrompt } from './prompts';
import {
  API_KEY_PROVIDERS,
  ApiKeyProvider,
  apiKeySource,
  PROVIDER_LABELS,
  ProviderFile,
  ProviderLimitError,
  ProviderName,
  ProviderUsage,
  resetProviderCache,
  setStoredApiKeys,
  TEXT_PROVIDERS,
  WEB_RESEARCH_KINDS,
} from './providers';
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
  /** Görev türüne göre önce denenecek sağlayıcı (sunucu geneli yönlendirme); yoksa otomatik sıra. */
  kindProviders?: KindProviders;
  /** Kurulumda gerçek sağlayıcı yerine kopyala-yapıştır köprüsüyle devam etmek seçildi. */
  manualAccepted?: boolean;
}

export type ModelProvider = 'cli_claude' | 'cli_codex';
export type ModelSettings = Partial<Record<ModelProvider, Partial<Record<AiKind | 'default', string>>>>;
export type KindProviders = Partial<Record<AiKind, ModelProvider>>;

/**
 * Sunucu geneli yapay zekâ yönlendirmesi: görev türüne göre hangi sağlayıcının önce deneneceği ve sağlayıcı başına
 * modeller. Yalnızca yönetici değiştirir; bütün çalışma alanlarına uygulanır.
 */
export interface AiRouting {
  providers: KindProviders;
  models: ModelSettings;
}

export const AI_ROUTING_KEY = 'server:ai-routing';
/** Worker'ın Codex CLI önbelleğinden okuduğu, hesabın kullanabildiği ChatGPT modelleri. */
export const CODEX_MODELS_KEY = 'ai:codex-models';

export interface ModelOption {
  value: string;
  label: string;
  description?: string;
}

/** Claude Code CLI model takma adları; CLI bunları güncel sürüme çevirir. */
export const CLAUDE_MODEL_OPTIONS: ModelOption[] = [
  { value: 'haiku', label: 'Haiku', description: 'Hızlı ve ucuz; kısa, kurallı işler' },
  { value: 'sonnet', label: 'Sonnet', description: 'Dengeli; çoğu iş için varsayılan' },
  { value: 'opus', label: 'Opus', description: 'En güçlü; yavaş ve kotayı çabuk tüketir' },
];

const LIGHT_KINDS: AiKind[] = ['cv_facts', 'title_expansion', 'title_analysis', 'company_sizes', 'reply_classification', 'inbound_review', 'job_alert'];

export const DEFAULT_MODELS: Record<ModelProvider, Partial<Record<AiKind | 'default', string>>> = {
  cli_claude: { default: 'sonnet', ...Object.fromEntries(LIGHT_KINDS.map((k) => [k, 'haiku'])), company_contacts: 'sonnet', contact_review: 'opus' },
  cli_codex: { company_contacts: 'gpt-6.1-sol' },
};

/** Bu görevlerde sağlayıcı sırasından bağımsız olarak önce denenen sağlayıcılar: adres araması Claude ile (Sonnet toplar, Opus doğrular); Claude yoksa ChatGPT yedektir. */
const PREFERRED_PROVIDERS: Partial<Record<AiKind, ProviderName[]>> = { company_contacts: ['cli_claude', 'cli_codex'], contact_review: ['cli_claude'] };

/**
 * Görevin sağlayıcı sırası: yöneticinin bu görev için seçtiği sağlayıcı önce, sonra görevin tercih edilenleri, sonra genel
 * sıra. Seçilen sağlayıcı limit ya da hata verirse sıradaki yedek olarak devralır.
 */
export function providerOrderFor(kind: AiKind, order: ProviderName[], chosen?: ModelProvider): ProviderName[] {
  const preferred = [...new Set([...(chosen ? [chosen] : []), ...(PREFERRED_PROVIDERS[kind] ?? [])])].filter((p) => order.includes(p));
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
/** Arayüzden hesap bağlanınca, çıkılınca ya da API anahtarı değişince yazılır; worker kurulu sağlayıcı listesini hemen tazeler. */
export const PROVIDERS_CHANGED_KEY = 'ai:providers-changed';
/** Arayüzden girilen API anahtarları (AES-256-GCM ile şifreli). */
export const API_KEYS_KEY = 'ai:api-keys';
const API_KEYS_SYNC_MS = 30_000;

interface StoredApiKey {
  secret: string;
  last4: string;
  savedAt: string;
}

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
  private apiKeysSyncedAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly usage: UsageService,
    private readonly outbox: OutboxService,
  ) {}

  async settings(workspaceId: string): Promise<AiSettings & { ownerIsAdmin: boolean; cliAllowed: boolean; maxDailyTaskLimit: number | null }> {
    await this.syncApiKeys();
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
    }
    const routing = await this.routing();
    s.models = routing.models;
    s.kindProviders = routing.providers;
    const defaultOrders = [DEFAULT_AI_SETTINGS.providerOrder.join(), ['cli_claude', ...DEFAULT_AI_SETTINGS.providerOrder].join()];
    const usesDefaultOrder = !stored.providerOrder || defaultOrders.includes(stored.providerOrder.join());
    // Arayüzden girilen API anahtarı, yönetici CLI'yı paylaştığı çalışma alanlarında varsayılan sıraya CLI'lardan sonra
    // girer. .env'deki anahtar eskisi gibi yalnızca elle sıraya eklenince kullanılır (habersiz ücretli kullanım olmasın).
    const storedKeyProviders = API_KEY_PROVIDERS.filter((p) => apiKeySource(p) === 'stored');
    if (usesDefaultOrder && cliAllowed) s.providerOrder = ['cli_claude', 'cli_codex', ...storedKeyProviders, ...DEFAULT_AI_SETTINGS.providerOrder];
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

  /**
   * Kurulum listesindeki yapay zekâ adımı: çalışma alanının sırasındaki gerçek sağlayıcılardan şu an kullanılabilenler.
   * Hesap bağlama API sürecinde yapıldığı için CLI'ların durumuna da bu süreçte bakılır (worker ile ortak ev klasörü).
   */
  async setupStatus(workspaceId: string) {
    const settings = await this.settings(workspaceId);
    const usable: ProviderName[] = [];
    for (const name of this.realProviders(settings)) if ((await TEXT_PROVIDERS[name].available()).ok) usable.push(name);
    return { ready: usable.length > 0, usable, manualAccepted: settings.manualAccepted === true, cliAllowed: settings.cliAllowed };
  }

  async markProvidersChanged() {
    resetProviderCache();
    const value = { at: new Date().toISOString() };
    await this.prisma.keyValue.upsert({ where: { key: PROVIDERS_CHANGED_KEY }, create: { key: PROVIDERS_CHANGED_KEY, value }, update: { value } });
  }

  async providersChangedAt(): Promise<number> {
    const kv = await this.prisma.keyValue.findUnique({ where: { key: PROVIDERS_CHANGED_KEY } });
    const at = (kv?.value as { at?: string } | null)?.at;
    return at ? new Date(at).getTime() : 0;
  }

  private async storedApiKeys(): Promise<Partial<Record<ApiKeyProvider, StoredApiKey>>> {
    const kv = await this.prisma.keyValue.findUnique({ where: { key: API_KEYS_KEY } });
    return (kv?.value ?? {}) as Partial<Record<ApiKeyProvider, StoredApiKey>>;
  }

  /** Şifreli anahtarlar en çok 30 saniyede bir okunup sağlayıcılara verilir; API'de değiştirilince worker bu sürede görür. */
  async syncApiKeys(force = false) {
    if (!force && Date.now() - this.apiKeysSyncedAt < API_KEYS_SYNC_MS) return;
    this.apiKeysSyncedAt = Date.now();
    const stored = await this.storedApiKeys();
    const plain: Partial<Record<ApiKeyProvider, string>> = {};
    for (const provider of API_KEY_PROVIDERS) {
      const entry = stored[provider];
      if (!entry) continue;
      try {
        plain[provider] = decryptSecret(entry.secret);
      } catch {
        this.logger.warn(`${PROVIDER_LABELS[provider]} anahtarı çözülemedi (APP_ENCRYPTION_KEY değişmiş olabilir); yeniden girilmeli`);
      }
    }
    setStoredApiKeys(plain);
  }

  async apiKeyStatus(): Promise<Record<ApiKeyProvider, ServerShape<ApiKeyStatus>>> {
    await this.syncApiKeys(true);
    const stored = await this.storedApiKeys();
    const status = (provider: ApiKeyProvider): ServerShape<ApiKeyStatus> => {
      const source = apiKeySource(provider);
      return { source, last4: source === 'stored' ? (stored[provider]?.last4 ?? null) : null, savedAt: source === 'stored' && stored[provider] ? new Date(stored[provider].savedAt) : null };
    };
    return { anthropic_api: status('anthropic_api'), openai_api: status('openai_api') };
  }

  async saveApiKey(provider: ApiKeyProvider, key: string | null) {
    const stored = await this.storedApiKeys();
    const next = { ...stored };
    if (key) next[provider] = { secret: encryptSecret(key), last4: key.slice(-4), savedAt: new Date().toISOString() };
    else delete next[provider];
    const value = next as unknown as Prisma.InputJsonValue;
    await this.prisma.keyValue.upsert({ where: { key: API_KEYS_KEY }, create: { key: API_KEYS_KEY, value }, update: { value } });
    await this.syncApiKeys(true);
    await this.markProvidersChanged();
    return this.apiKeyStatus();
  }

  async installedProviders(): Promise<Record<string, boolean>> {
    await this.syncApiKeys();
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
      ...((patch.manualAccepted ?? current.manualAccepted) !== undefined ? { manualAccepted: patch.manualAccepted ?? current.manualAccepted } : {}),
    };
    await this.prisma.workspace.update({ where: { id: workspaceId }, data: { aiSettings: next as Prisma.InputJsonValue } });
    if (patch.models && current.ownerIsAdmin) await this.updateRouting({ models: patch.models });
    return this.providerStatus(workspaceId);
  }

  /**
   * Sunucu geneli yönlendirme. Henüz kaydedilmemişse yöneticinin çalışma alanındaki eski model ayarı kullanılır (bu
   * ayar önceden yalnızca yöneticinin çalışma alanına uygulanıyordu).
   */
  async routing(): Promise<AiRouting> {
    const kv = await this.prisma.keyValue.findUnique({ where: { key: AI_ROUTING_KEY } });
    if (kv) {
      const stored = kv.value as Partial<AiRouting>;
      return { providers: stored.providers ?? {}, models: stored.models ?? {} };
    }
    const admin = await this.prisma.workspace.findFirst({ where: { ownerId: { in: (await this.prisma.user.findMany({ where: { isAdmin: true }, select: { id: true } })).map((u) => u.id) } }, orderBy: { createdAt: 'asc' } });
    return { providers: {}, models: ((admin?.aiSettings ?? {}) as Partial<AiSettings>).models ?? {} };
  }

  /** Yalnızca yönetici çağırır (denetim API katmanında). Gönderilen alanlar mevcut yönlendirmenin üzerine yazılır. */
  async updateRouting(patch: Partial<AiRouting>): Promise<AiRouting> {
    const current = await this.routing();
    const next: AiRouting = { providers: patch.providers ?? current.providers, models: patch.models ?? current.models };
    const value = next as unknown as Prisma.InputJsonValue;
    await this.prisma.keyValue.upsert({ where: { key: AI_ROUTING_KEY }, create: { key: AI_ROUTING_KEY, value }, update: { value } });
    return next;
  }

  /** Seçim kutularının seçenekleri: Claude takma adları ve worker'ın bildirdiği ChatGPT modelleri; kayıtlı ama listede olmayan değer de eklenir. */
  async modelOptions(): Promise<Record<ModelProvider, ModelOption[]>> {
    const kv = await this.prisma.keyValue.findUnique({ where: { key: CODEX_MODELS_KEY } });
    const codex = ((kv?.value as { models?: ModelOption[] } | null)?.models ?? []) as ModelOption[];
    const fallback: ModelOption[] = Object.values(DEFAULT_MODELS.cli_codex)
      .filter((m): m is string => !!m)
      .map((value) => ({ value, label: value }));
    const options: Record<ModelProvider, ModelOption[]> = { cli_claude: [...CLAUDE_MODEL_OPTIONS], cli_codex: codex.length ? codex : fallback };
    const { models } = await this.routing();
    for (const provider of Object.keys(options) as ModelProvider[]) {
      for (const value of Object.values(models[provider] ?? {})) {
        if (value && !options[provider].some((o) => o.value === value)) options[provider].push({ value, label: value, description: 'Listede yok; sağlayıcı artık sunmuyor olabilir' });
      }
    }
    return options;
  }

  /**
   * Worker'da: Codex CLI'nin model önbelleğinden (~/.codex/models_cache.json) hesabın kullanabildiği, listede görünen
   * modelleri okuyup kaydeder. Dosya yoksa (Codex kurulu değil) bir şey yazmaz.
   */
  async refreshCodexModels(): Promise<number> {
    const file = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'models_cache.json');
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch {
      return 0;
    }
    const parsed = JSON.parse(raw) as { models?: { slug?: string; display_name?: string; description?: string; visibility?: string }[] };
    const models: ModelOption[] = (parsed.models ?? [])
      .filter((m) => m.slug && m.visibility !== 'hide')
      .map((m) => ({ value: m.slug!, label: m.display_name ?? m.slug!, ...(m.description ? { description: m.description } : {}) }));
    if (!models.length) return 0;
    const value = { at: new Date().toISOString(), models } as unknown as Prisma.InputJsonValue;
    await this.prisma.keyValue.upsert({ where: { key: CODEX_MODELS_KEY }, create: { key: CODEX_MODELS_KEY, value }, update: { value } });
    return models.length;
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

    for (const name of providerOrderFor(req.kind, settings.providerOrder, settings.kindProviders?.[req.kind])) {
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
