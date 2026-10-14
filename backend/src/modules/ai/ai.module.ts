import { Body, Controller, Get, Injectable, Module, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Ctx, RequestContext } from '../../common/auth';
import { AppError, notFound } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { ZodPipe } from '../../common/zod.pipe';
import { AiService, DEFAULT_MODELS, modelFor } from '../../engine/ai/ai.service';
import { PROVIDER_LABELS, TEXT_PROVIDERS, resetProviderCache } from '../../engine/ai/providers';
import { AI_KIND_LABELS } from '../../engine/ai/schemas';

const settingsSchema = z.object({
  providerOrder: z.array(z.enum(['cli_claude', 'cli_codex', 'manual', 'ollama', 'anthropic_api', 'openai_api', 'template'])).optional(),
  dailyTaskLimit: z.number().int().min(0).max(1000).optional(),
  webResearch: z.boolean().optional(),
  dailyDiscovery: z.boolean().optional(),
  discoveryLimit: z.number().int().min(1).max(50).optional(),
  models: z.record(z.enum(['cli_claude', 'cli_codex']), z.record(z.string(), z.string().max(80))).optional(),
});

@Injectable()
export class AiApiService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
  ) {}

  async status(ctx: RequestContext) {
    return { ...(await this.ai.providerStatus(ctx.workspaceId)), kindLabels: AI_KIND_LABELS, defaultModels: DEFAULT_MODELS, cooldowns: await this.ai.cooldowns() };
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
  ) {}

  @Get('status')
  status(@Ctx() ctx: RequestContext) {
    return this.svc.status(ctx);
  }

  @Patch('settings')
  settings(@Ctx() ctx: RequestContext, @Body(new ZodPipe(settingsSchema)) body: z.infer<typeof settingsSchema>) {
    return this.ai.updateSettings(ctx.workspaceId, body as any);
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

@Module({ controllers: [AiController], providers: [AiApiService] })
export class AiModule {}
