import { Body, Controller, Delete, Get, Injectable, Module, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { AdminOnly, Ctx, RequestContext } from '../../common/auth';
import { AppError, notFound } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { ZodPipe } from '../../common/zod.pipe';
import { AiService, DEFAULT_MODELS, ModelProvider, modelFor } from '../../engine/ai/ai.service';
import { API_KEY_PROVIDERS, ApiKeyProvider, PROVIDER_LABELS, TEXT_PROVIDERS, resetProviderCache } from '../../engine/ai/providers';
import { AI_KIND_LABELS } from '../../engine/ai/schemas';
import type { AiSetupStatus, ConnectProvider } from '../../contracts/ai-setup';
import type { ServerShape } from '../../contracts/wire';
import { AiConnectService, CONNECT_PROVIDERS } from './ai-connect.service';

const settingsSchema = z.object({
  providerOrder: z.array(z.enum(['cli_claude', 'cli_codex', 'manual', 'ollama', 'anthropic_api', 'openai_api', 'template'])).optional(),
  dailyTaskLimit: z.number().int().min(0).max(1000).optional(),
  webResearch: z.boolean().optional(),
  dailyDiscovery: z.boolean().optional(),
  discoveryLimit: z.number().int().min(1).max(50).optional(),
  models: z.record(z.enum(['cli_claude', 'cli_codex']), z.record(z.string(), z.string().max(80))).optional(),
});

const MODEL_PROVIDERS = ['cli_claude', 'cli_codex'] as const;
const connectProviderPipe = new ZodPipe(z.enum(CONNECT_PROVIDERS as [ConnectProvider, ...ConnectProvider[]]));
/** Claude'un giriş sayfasının verdiği kod tek parça olmalı; satır sonu sürecin girişine ikinci bir yanıt yazdırmasın. */
const loginCodeSchema = z.object({ code: z.string().trim().min(4).max(2000).regex(/^\S+$/, 'Kod boşluk içeremez') });
const apiKeyProviderPipe = new ZodPipe(z.enum(API_KEY_PROVIDERS as [ApiKeyProvider, ...ApiKeyProvider[]]));
const apiKeySchema = z.object({ key: z.string().trim().min(20).max(400).regex(/^\S+$/, 'Anahtar boşluk içeremez') });
const manualSchema = z.object({ accepted: z.boolean() });
const routingSchema = z.object({
  providers: z.record(z.string(), z.enum(['auto', ...MODEL_PROVIDERS])).optional(),
  models: z.record(z.enum(MODEL_PROVIDERS), z.record(z.string(), z.string().max(80))).optional(),
});

@Injectable()
export class AiApiService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
    private readonly connect: AiConnectService,
  ) {}

  async status(ctx: RequestContext) {
    const [providerStatus, routing, modelOptions, cooldowns] = await Promise.all([this.ai.providerStatus(ctx.workspaceId), this.ai.routing(), this.ai.modelOptions(), this.ai.cooldowns()]);
    return { ...providerStatus, kindLabels: AI_KIND_LABELS, defaultModels: DEFAULT_MODELS, cooldowns, routing, modelOptions };
  }

  /**
   * Görev türüne göre sağlayıcı ve modeller (sunucu geneli). Model adı yalnızca seçenek listesinden gelebilir; boş değer
   * "varsayılan" demektir. "auto" seçilen görevin kaydı silinir.
   */
  async updateRouting(body: z.infer<typeof routingSchema>) {
    const kinds = new Set(Object.keys(AI_KIND_LABELS));
    const providers = body.providers
      ? Object.fromEntries(
          Object.entries(body.providers).filter(([kind, provider]) => {
            if (!kinds.has(kind)) throw new AppError(400, 'AI_KIND_UNKNOWN', `Bilinmeyen görev türü: ${kind}`);
            return provider !== 'auto';
          }),
        )
      : undefined;
    let models = body.models;
    if (models) {
      const options = await this.ai.modelOptions();
      models = Object.fromEntries(
        Object.entries(models).map(([provider, byKind]) => [
          provider,
          Object.fromEntries(
            Object.entries(byKind).filter(([kind, model]) => {
              if (kind !== 'default' && !kinds.has(kind)) throw new AppError(400, 'AI_KIND_UNKNOWN', `Bilinmeyen görev türü: ${kind}`);
              if (model && !options[provider as ModelProvider].some((o) => o.value === model)) throw new AppError(400, 'AI_MODEL_UNKNOWN', `${model} bu sağlayıcının model listesinde yok`);
              return !!model;
            }),
          ),
        ]),
      );
    }
    await this.ai.updateRouting({ ...(providers ? { providers } : {}), ...(models ? { models } : {}) });
    return this.ai.routing();
  }

  async tasks(ctx: RequestContext, status?: string) {
    return this.prisma.aiTask.findMany({
      where: { workspaceId: ctx.workspaceId, ...(status ? { status: { in: status.split(',') } } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: { id: true, kind: true, provider: true, status: true, entityType: true, entityId: true, error: true, createdAt: true, completedAt: true },
    });
  }

  async task(ctx: RequestContext, id: string) {
    const t = await this.prisma.aiTask.findFirst({ where: { id, workspaceId: ctx.workspaceId } });
    if (!t) throw notFound('AI görevi');
    return { ...t, kindLabel: AI_KIND_LABELS[t.kind as keyof typeof AI_KIND_LABELS], chatLinks: { claude: 'https://claude.ai/new', chatgpt: 'https://chatgpt.com/' } };
  }

  /**
   * Kurulum listesinin yapay zekâ adımı. Herkes kendi çalışma alanının durumunu görür; hesap bağlama ve anahtar
   * bilgisi yalnızca yöneticiye döner.
   */
  async setup(ctx: RequestContext): Promise<ServerShape<AiSetupStatus>> {
    const status = await this.ai.setupStatus(ctx.workspaceId);
    if (!ctx.isAdmin) return { ...status, canManage: false, connections: null, apiKeys: null };
    const [connections, apiKeys] = await Promise.all([this.connect.statuses(), this.ai.apiKeyStatus()]);
    return { ...status, canManage: true, connections, apiKeys };
  }

  async acceptManual(ctx: RequestContext, accepted: boolean): Promise<ServerShape<AiSetupStatus>> {
    await this.ai.updateSettings(ctx.workspaceId, { manualAccepted: accepted });
    return this.setup(ctx);
  }

  /** Bağlantı testi: kısa bir istemle sağlayıcının JSON döndürdüğünü doğrular. */
  async test(ctx: RequestContext, provider: string) {
    const p = TEXT_PROVIDERS[provider];
    if (!p) throw new AppError(400, 'PROVIDER_UNKNOWN', 'Test edilebilir bir sağlayıcı değil');
    const s = await this.ai.settings(ctx.workspaceId);
    if (p.ownerOnly && !s.cliAllowed) throw new AppError(403, 'PROVIDER_NOT_ALLOWED', 'Bu sağlayıcı yalnızca sunucu sahibinin çalışma alanında kullanılabilir');
    resetProviderCache();
    const avail = await p.available();
    if (!avail.ok) return { ok: false, detail: avail.detail };
    const started = Date.now();
    try {
      const out = (await p.complete('Yalnızca şu JSON nesnesini döndür, başka hiçbir şey yazma: {"ok": true}', { kind: 'title_analysis', model: modelFor(provider, 'title_analysis', s.models) })).text;
      return { ok: /"ok"\s*:\s*true/.test(out), detail: out.slice(0, 200), ms: Date.now() - started };
    } catch (e) {
      return { ok: false, detail: (e as Error).message.slice(0, 300) };
    }
  }
}

@Controller('v1/ai')
export class AiController {
  constructor(
    private readonly svc: AiApiService,
    private readonly ai: AiService,
    private readonly connect: AiConnectService,
  ) {}

  @Get('connect')
  @AdminOnly()
  connections() {
    return this.connect.statuses();
  }

  @Post('connect/:provider/login')
  @AdminOnly()
  startLogin(@Param('provider', connectProviderPipe) provider: ConnectProvider) {
    return this.connect.start(provider);
  }

  @Post('connect/:provider/code')
  @AdminOnly()
  submitLoginCode(@Param('provider', connectProviderPipe) provider: ConnectProvider, @Body(new ZodPipe(loginCodeSchema)) body: z.infer<typeof loginCodeSchema>) {
    return this.connect.submitCode(provider, body.code);
  }

  @Delete('connect/:provider/login')
  @AdminOnly()
  cancelLogin(@Param('provider', connectProviderPipe) provider: ConnectProvider) {
    this.connect.cancel(provider);
    return this.connect.status(provider);
  }

  @Post('connect/:provider/logout')
  @AdminOnly()
  logout(@Param('provider', connectProviderPipe) provider: ConnectProvider) {
    return this.connect.logout(provider);
  }

  @Get('setup')
  setup(@Ctx() ctx: RequestContext) {
    return this.svc.setup(ctx);
  }

  @Post('setup/manual')
  acceptManual(@Ctx() ctx: RequestContext, @Body(new ZodPipe(manualSchema)) body: z.infer<typeof manualSchema>) {
    return this.svc.acceptManual(ctx, body.accepted);
  }

  @Get('api-keys')
  @AdminOnly()
  apiKeys() {
    return this.ai.apiKeyStatus();
  }

  /** Anthropic / OpenAI API anahtarı: şifreli saklanır, bir daha gösterilmez (yalnızca son 4 karakteri). */
  @Put('api-keys/:provider')
  @AdminOnly()
  saveApiKey(@Param('provider', apiKeyProviderPipe) provider: ApiKeyProvider, @Body(new ZodPipe(apiKeySchema)) body: z.infer<typeof apiKeySchema>) {
    return this.ai.saveApiKey(provider, body.key);
  }

  @Delete('api-keys/:provider')
  @AdminOnly()
  deleteApiKey(@Param('provider', apiKeyProviderPipe) provider: ApiKeyProvider) {
    return this.ai.saveApiKey(provider, null);
  }

  @Get('status')
  status(@Ctx() ctx: RequestContext) {
    return this.svc.status(ctx);
  }

  @Patch('settings')
  settings(@Ctx() ctx: RequestContext, @Body(new ZodPipe(settingsSchema)) body: z.infer<typeof settingsSchema>) {
    return this.ai.updateSettings(ctx.workspaceId, body as any);
  }

  @Patch('routing')
  @AdminOnly()
  routing(@Body(new ZodPipe(routingSchema)) body: z.infer<typeof routingSchema>) {
    return this.svc.updateRouting(body);
  }

  @Post('test')
  test(@Ctx() ctx: RequestContext, @Body(new ZodPipe(z.object({ provider: z.string() }))) body: { provider: string }) {
    return this.svc.test(ctx, body.provider);
  }

  @Get('providers')
  providers() {
    return PROVIDER_LABELS;
  }

  @Get('tasks')
  tasks(@Ctx() ctx: RequestContext, @Query('status') status?: string) {
    return this.svc.tasks(ctx, status);
  }

  @Get('tasks/:id')
  task(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.svc.task(ctx, id);
  }

  @Post('tasks/:id/submit')
  submit(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new ZodPipe(z.object({ text: z.string().min(2).max(200_000) }))) body: { text: string }) {
    return this.ai.submitManual(ctx.workspaceId, id, body.text);
  }

  @Post('tasks/:id/template')
  template(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.ai.completeWithTemplate(ctx.workspaceId, id);
  }

  @Post('tasks/:id/cancel')
  cancel(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.ai.cancel(ctx.workspaceId, id);
  }
}

@Module({ controllers: [AiController], providers: [AiApiService, AiConnectService] })
export class AiModule {}
