import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Ctx, RequestContext } from '../../common/auth';
import { ZodPipe } from '../../common/zod.pipe';
import type { CompanyDecisionView, SimilarCompanyView } from '../../contracts/home';
import { ServerShape } from '../../contracts/wire';
import { CompanyDecisionService } from '../../engine/company-decision.service';

const decideSchema = z.object({ action: z.enum(['merge', 'separate']) });
const similarSchema = z.object({ name: z.string().trim().min(2).max(120) });

@Controller('v1/home')
export class CompanyDecisionsController {
  constructor(private readonly decisions: CompanyDecisionService) {}

  @Get('company-decisions')
  async list(@Ctx() ctx: RequestContext): Promise<ServerShape<CompanyDecisionView[]>> {
    return this.decisions.list(ctx.workspaceId);
  }

  @Post('company-decisions/:id')
  decide(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new ZodPipe(decideSchema)) body: z.infer<typeof decideSchema>) {
    return this.decisions.decide(ctx.workspaceId, id, body.action, ctx.userId);
  }

  @Get('companies/similar')
  async similar(@Ctx() ctx: RequestContext, @Query(new ZodPipe(similarSchema)) query: z.infer<typeof similarSchema>): Promise<ServerShape<SimilarCompanyView>> {
    return { match: await this.decisions.similar(ctx.workspaceId, query.name) };
  }
}
