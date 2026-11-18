import { Body, Controller, Get, Injectable, Put } from '@nestjs/common';
import { z } from 'zod';
import { Ctx, RequestContext } from '../../common/auth';
import { ZodPipe } from '../../common/zod.pipe';
import type { ContactSearchView } from '../../contracts/contact-search';
import { contactSearchPlan, MAX_OPUS_DAILY_LIMIT, RETRY_PLAN_NAMES, RETRY_PLANS } from '../../domain/contact-search';
import { AiService } from '../../engine/ai/ai.service';
import { ResearchService } from '../../engine/research.service';

export const contactSearchSettingsSchema = z.object({
  retryPlan: z.enum(RETRY_PLAN_NAMES as [string, ...string[]]),
  opusRetry: z.boolean(),
  opusDailyLimit: z.number().int().min(1).max(MAX_OPUS_DAILY_LIMIT),
  retryOnNewInfo: z.boolean(),
});

/**
 * Adres aramasının ayarları ve durumu: bulunamayan firmaların yeniden arama takvimi, Opus ile tekrar (günlük hakla) ve
 * yeni bilgi gelince yeniden arama. Ayarlar çalışma alanının yapay zekâ ayarlarında saklanır.
 */
@Injectable()
export class ContactSearchService {
  constructor(
    private readonly ai: AiService,
    private readonly research: ResearchService,
  ) {}

  async view(workspaceId: string, now = new Date()): Promise<ContactSearchView> {
    const settings = await this.research.contactSearchSettings(workspaceId);
    const companies = await this.research.addresslessCompanies(workspaceId);
    const retryDays = RETRY_PLANS[settings.retryPlan];
    return {
      settings,
      plans: Object.fromEntries(RETRY_PLAN_NAMES.map((name) => [name, [...RETRY_PLANS[name]]])) as ContactSearchView['plans'],
      maxOpusDailyLimit: MAX_OPUS_DAILY_LIMIT,
      summary: {
        withoutAddress: companies.length,
        awaitingOpus: settings.opusRetry ? companies.filter((c) => !c.meta.opusSearchedAt).length : 0,
        opusUsedToday: await this.research.opusUsedToday(workspaceId, now),
        dueNow: companies.filter((c) => contactSearchPlan(c.meta, { deep: false }, now.getTime(), retryDays).skip === null).length,
      },
    };
  }

  async save(workspaceId: string, input: z.infer<typeof contactSearchSettingsSchema>) {
    await this.ai.updateSettings(workspaceId, { contactSearch: input as ContactSearchView['settings'] });
    return this.view(workspaceId);
  }
}

@Controller('v1/home/contact-search')
export class ContactSearchController {
  constructor(private readonly svc: ContactSearchService) {}

  @Get('settings')
  view(@Ctx() ctx: RequestContext) {
    return this.svc.view(ctx.workspaceId);
  }

  @Put('settings')
  save(@Ctx() ctx: RequestContext, @Body(new ZodPipe(contactSearchSettingsSchema)) body: z.infer<typeof contactSearchSettingsSchema>) {
    return this.svc.save(ctx.workspaceId, body);
  }
}
