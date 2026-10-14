import { Body, Controller, Delete, Get, Headers, Injectable, Module, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { AuditService } from '../../common/audit.service';
import { Ctx, Public, RequestContext } from '../../common/auth';
import { decryptSecret, encryptSecret, randomToken } from '../../common/crypto';
import { env } from '../../common/env';
import { AppError } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { ScopeService } from '../../common/scope.service';
import { ZodPipe } from '../../common/zod.pipe';
import { SendingService } from '../../engine/sending.service';
import { gmailAuthUrl, gmailExchangeCode, gmailRedirectUri, gmailRevoke, verifySmtp } from '../../engine/mail/providers';

const OAUTH_COOKIE = 'jt_gmail_oauth';

const fakeSchema = z.object({ candidateId: z.string(), accountEmail: z.string().email(), displayName: z.string().max(120).optional(), dailyLimit: z.number().int().min(1).max(500).default(300) });
const smtpSchema = z.object({
  candidateId: z.string(),
  accountEmail: z.string().email(),
  displayName: z.string().max(120).optional(),
  smtpHost: z.string().min(3),
  smtpPort: z.number().int().min(1).max(65535).default(465),
  smtpSecure: z.boolean().default(true),
  smtpUser: z.string().optional(),
  appPassword: z.string().min(4),
  dailyLimit: z.number().int().min(1).max(500).default(300),
});
const patchSchema = z.object({ displayName: z.string().max(120).optional(), dailyLimit: z.number().int().min(1).max(500).optional() });

@Injectable()
export class MailAccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
    private readonly sending: SendingService,
  ) {}

  /** Parola/token hiçbir yanıtta dönmez. */
  private safe<T extends { encryptedSecret?: string | null }>(a: T) {
    const { encryptedSecret, ...rest } = a;
    return { ...rest, hasSecret: !!encryptedSecret };
  }

  async list(ctx: RequestContext) {
    const rows = await this.prisma.mailAccount.findMany({ where: { workspaceId: ctx.workspaceId }, orderBy: { createdAt: 'asc' } });
    return {
      accounts: rows.map((r) => this.safe(r)),
      gmailConfigured: !!(env().GOOGLE_CLIENT_ID && env().GOOGLE_CLIENT_SECRET),
      gmailRedirectUri: gmailRedirectUri(),
      fakeEnabled: env().FAKE_MAIL_ENABLED,
    };
  }

  async addFake(ctx: RequestContext, input: z.infer<typeof fakeSchema>) {
    if (!env().FAKE_MAIL_ENABLED) throw new AppError(403, 'FAKE_DISABLED', 'Test sağlayıcısı kapalı');
    await this.scope.candidate(ctx, input.candidateId);
    const a = await this.prisma.mailAccount.create({ data: { ...input, workspaceId: ctx.workspaceId, provider: 'fake', scopeSet: ['send'] } });
    await this.audit.log({ workspaceId: ctx.workspaceId, actorId: ctx.userId, action: 'mail_account.add', entityType: 'MailAccount', entityId: a.id, next: { provider: 'fake' } });
    return this.safe(a);
  }

  async addSmtp(ctx: RequestContext, input: z.infer<typeof smtpSchema>) {
    await this.scope.candidate(ctx, input.candidateId);
    const { appPassword, ...rest } = input;
    // Uygulama parolası şifreli saklanır; profil ve loglarda gösterilmez.
    try {
      await verifySmtp({ host: rest.smtpHost, port: rest.smtpPort, secure: rest.smtpSecure, user: rest.smtpUser ?? rest.accountEmail, pass: appPassword });
    } catch (e) {
      throw new AppError(422, 'SMTP_VERIFY_FAILED', (e as Error).message);
    }
    const a = await this.prisma.mailAccount.create({ data: { ...rest, workspaceId: ctx.workspaceId, provider: 'smtp', encryptedSecret: encryptSecret(appPassword), scopeSet: ['send'] } });
    await this.audit.log({ workspaceId: ctx.workspaceId, actorId: ctx.userId, action: 'mail_account.add', entityType: 'MailAccount', entityId: a.id, next: { provider: 'smtp' } });
    return this.safe(a);
  }

  /**
   * OAuth başlangıcı: state, sunucuda saklanan tek kullanımlık rastgele nonce'tur ve akışı başlatan
   * tarayıcıya HttpOnly çerezle bağlanır (başkasına gönderilen bağlantı hesabı saldırgana bağlayamaz).
   */
  async gmailStart(ctx: RequestContext, candidateId: string, res: Response) {
    if (!env().GOOGLE_CLIENT_ID || !env().GOOGLE_CLIENT_SECRET) throw new AppError(422, 'GMAIL_NOT_CONFIGURED', 'Sunucuda GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET tanımlı değil (docs/SETUP.md)');
    await this.scope.candidate(ctx, candidateId);
    const nonce = randomToken(24);
    await this.prisma.keyValue.create({
      data: { key: `oauth:gmail:${nonce}`, value: { ws: ctx.workspaceId, cid: candidateId, uid: ctx.userId, exp: Date.now() + 10 * 60_000 } },
    });
    const secure = env().APP_PUBLIC_URL.startsWith('https://');
    res.cookie(OAUTH_COOKIE, nonce, { httpOnly: true, sameSite: 'lax', secure, maxAge: 10 * 60_000, path: '/api/v1/mail-accounts/gmail' });
    return { url: gmailAuthUrl(nonce) };
  }

  async gmailCallback(code: string | undefined, state: string | undefined, error: string | undefined, cookieHeader: string | undefined, res: Response) {
    const back = (q: string) => res.redirect(`${env().APP_PUBLIC_URL.replace(/\/$/, '')}/#/accounts?${q}`);
    res.clearCookie(OAUTH_COOKIE, { path: '/api/v1/mail-accounts/gmail' });
    if (error || !code || !state) return back(`gmail=error&reason=${encodeURIComponent(error ?? 'eksik parametre')}`);
    const cookieNonce = (cookieHeader ?? '')
      .split(';')
      .map((c) => c.trim().split('='))
      .find(([k]) => k === OAUTH_COOKIE)?.[1];
    if (!cookieNonce || cookieNonce !== state || !/^[A-Za-z0-9_-]{20,64}$/.test(state)) return back('gmail=error&reason=state');
    const row = await this.prisma.keyValue.findUnique({ where: { key: `oauth:gmail:${state}` } });
    if (!row) return back('gmail=error&reason=state');
    await this.prisma.keyValue.delete({ where: { key: row.key } }).catch(() => undefined);
    const payload = row.value as { ws: string; cid: string; uid: string; exp: number };
    if (!payload?.exp || payload.exp < Date.now()) return back('gmail=error&reason=state_expired');
    try {
      const tok = await gmailExchangeCode(code);
      if (!tok.refreshToken) return back('gmail=error&reason=refresh_token_yok');
      if (!tok.scope.includes('gmail.send')) return back('gmail=error&reason=gonderim_yetkisi_verilmedi');
      const email = (tok.email ?? '').toLowerCase();
      const cand = await this.prisma.candidateProfile.findFirst({ where: { id: payload.cid, workspaceId: payload.ws } });
      if (!cand) return back('gmail=error&reason=aday_bulunamadi');
      await this.prisma.mailAccount.upsert({
        where: { candidateId_provider_accountEmail: { candidateId: payload.cid, provider: 'gmail', accountEmail: email } },
        create: { workspaceId: payload.ws, candidateId: payload.cid, provider: 'gmail', accountEmail: email, encryptedSecret: encryptSecret(tok.refreshToken), scopeSet: tok.scope.split(' '), health: 'ok' },
        update: { encryptedSecret: encryptSecret(tok.refreshToken), scopeSet: tok.scope.split(' '), health: 'ok', healthReason: null },
      });
      await this.audit.log({ workspaceId: payload.ws, actorId: payload.uid, action: 'mail_account.gmail_connect', entityType: 'MailAccount', next: { email } });
      return back('gmail=ok');
    } catch (e) {
      return back(`gmail=error&reason=${encodeURIComponent((e as Error).message.slice(0, 80))}`);
    }
  }

  async update(ctx: RequestContext, id: string, input: z.infer<typeof patchSchema>) {
    await this.scope.mailAccount(ctx, id);
    return this.safe(await this.prisma.mailAccount.update({ where: { id }, data: input }));
  }

  /** Hesap kaldırılınca sunucudaki token silinir, kuyruk gönderimleri durur ve sağlayıcı yetki iptali yapılır. */
  async remove(ctx: RequestContext, id: string, revoke: boolean) {
    const a = await this.scope.mailAccount(ctx, id);
    if (revoke && a.provider === 'gmail' && a.encryptedSecret) await gmailRevoke(decryptSecret(a.encryptedSecret));
    await this.prisma.$transaction(async (tx) => {
      await this.sending.cancelQueued({ mailAccountId: id }, 'ACCOUNT_REMOVED', tx);
      await tx.automationPolicy.updateMany({ where: { mailAccountId: id, active: true }, data: { active: false, disabledAt: new Date(), version: { increment: 1 } } });
      await tx.applicationDraft.updateMany({ where: { mailAccountId: id, status: { in: ['draft', 'needs_review'] } }, data: { mailAccountId: null } });
      await tx.mailAccount.delete({ where: { id } });
    });
    await this.audit.log({ workspaceId: ctx.workspaceId, actorId: ctx.userId, action: 'mail_account.remove', entityType: 'MailAccount', entityId: id, next: { revoke } });
    return { ok: true };
  }
}

@Controller('v1/mail-accounts')
export class MailAccountsController {
  constructor(private readonly svc: MailAccountsService) {}

  @Get()
  list(@Ctx() ctx: RequestContext) {
    return this.svc.list(ctx);
  }

  @Post('fake')
  fake(@Ctx() ctx: RequestContext, @Body(new ZodPipe(fakeSchema)) body: z.infer<typeof fakeSchema>) {
    return this.svc.addFake(ctx, body);
  }

  @Post('smtp')
  smtp(@Ctx() ctx: RequestContext, @Body(new ZodPipe(smtpSchema)) body: z.infer<typeof smtpSchema>) {
    return this.svc.addSmtp(ctx, body);
  }

  @Post('gmail/start')
  gmailStart(@Ctx() ctx: RequestContext, @Body(new ZodPipe(z.object({ candidateId: z.string() }))) body: { candidateId: string }, @Res({ passthrough: true }) res: Response) {
    return this.svc.gmailStart(ctx, body.candidateId, res);
  }

  @Public()
  @Get('gmail/callback')
  gmailCallback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Res() res: Response,
  ) {
    return this.svc.gmailCallback(code, state, error, cookie, res);
  }

  @Patch(':id')
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new ZodPipe(patchSchema)) body: z.infer<typeof patchSchema>) {
    return this.svc.update(ctx, id, body);
  }

  @Delete(':id')
  remove(@Ctx() ctx: RequestContext, @Param('id') id: string, @Query('revoke') revoke?: string) {
    return this.svc.remove(ctx, id, revoke !== 'false');
  }
}

@Module({ controllers: [MailAccountsController], providers: [MailAccountsService] })
export class MailModule {}
