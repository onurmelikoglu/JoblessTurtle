import { Body, Controller, Get, Injectable, Module, Param, Patch, Post } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { z } from 'zod';
import { AuditService } from '../../common/audit.service';
import { AdminOnly, Ctx, Public, RequestContext } from '../../common/auth';
import { randomCode, randomToken, sha256 } from '../../common/crypto';
import { env } from '../../common/env';
import { AppError } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { ZodPipe } from '../../common/zod.pipe';

const registerSchema = z.object({
  email: z.string().email().transform((v) => v.toLowerCase().trim()),
  password: z.string().min(8, 'Şifre en az 8 karakter olmalı'),
  displayName: z.string().min(1).max(120),
  inviteCode: z.string().optional(),
});
const loginSchema = z.object({ email: z.string().email().transform((v) => v.toLowerCase().trim()), password: z.string() });
const refreshSchema = z.object({ refreshToken: z.string().min(10) });
const meSchema = z.object({
  displayName: z.string().min(1).max(120).optional(),
  notificationSettings: z
    .object({
      mode: z.enum(['instant', 'digest']).optional(),
      quietStart: z.string().optional(),
      quietEnd: z.string().optional(),
      minScore: z.number().min(0).max(100).optional(),
      telegramEnabled: z.boolean().optional(),
      types: z.record(z.boolean()).optional(),
    })
    .optional(),
});
const passwordSchema = z.object({ currentPassword: z.string(), newPassword: z.string().min(8, 'Şifre en az 8 karakter olmalı') });
const MAX_FAILED_LOGINS = 10;
const LOGIN_WINDOW_MS = 15 * 60_000;
const TEMP_PASSWORD_LENGTH = 12;
const inviteSchema = z.object({ email: z.string().email().optional(), days: z.number().int().min(1).max(60).default(14) });

@Injectable()
export class AuthService {
  private readonly failedLogins = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
  ) {}

  async status() {
    const users = await this.prisma.user.count();
    return { needsSetup: users === 0, registrationMode: env().REGISTRATION_MODE };
  }

  async register(input: z.infer<typeof registerSchema>) {
    const userCount = await this.prisma.user.count();
    const first = userCount === 0;
    return this.prisma.$transaction(async (tx) => {
      if (await tx.user.findUnique({ where: { email: input.email } }))
        throw new AppError(409, 'EMAIL_TAKEN', 'Bu e-posta ile kayıtlı kullanıcı var');
      let inviteId: string | null = null;
      if (!first && env().REGISTRATION_MODE === 'invite') {
        if (!input.inviteCode) throw new AppError(403, 'INVITE_REQUIRED', 'Kayıt için davet kodu gerekli');
        const invite = await tx.invite.findUnique({ where: { code: input.inviteCode.trim().toUpperCase() } });
        if (!invite || invite.usedAt || invite.expiresAt < new Date())
          throw new AppError(403, 'INVITE_INVALID', 'Davet kodu geçersiz veya süresi dolmuş');
        if (invite.email && invite.email.toLowerCase() !== input.email)
          throw new AppError(403, 'INVITE_EMAIL_MISMATCH', 'Davet bu e-posta için oluşturulmamış');
        inviteId = invite.id;
      }
      const user = await tx.user.create({
        data: {
          email: input.email,
          passwordHash: await argon2.hash(input.password),
          displayName: input.displayName,
          isAdmin: first,
          notificationSettings: { mode: 'instant', quietStart: '23:00', quietEnd: '08:00', minScore: 0, telegramEnabled: true },
        },
      });
      if (inviteId) {
        const used = await tx.invite.updateMany({
          where: { id: inviteId, usedAt: null },
          data: { usedAt: new Date(), usedByEmail: input.email },
        });
        if (used.count !== 1) throw new AppError(403, 'INVITE_INVALID', 'Davet kodu zaten kullanıldı');
      }
      // Her kullanıcının ayrı workspace'i vardır; CV, hesap, politika ve geçmiş kullanıcıya özeldir.
      const ws = await tx.workspace.create({
        data: {
          name: `${input.displayName} çalışma alanı`,
          ownerId: user.id,
          aiSettings: { providerOrder: first ? ['cli_claude', 'manual', 'template'] : ['manual', 'template'], dailyTaskLimit: 60 },
        },
      });
      await tx.membership.create({ data: { workspaceId: ws.id, userId: user.id, role: 'owner' } });
      await this.audit.log({ workspaceId: ws.id, actorId: user.id, action: 'user.register', entityType: 'User', entityId: user.id }, tx);
      return this.issueTokens(user.id, user.email, user.isAdmin, tx);
    });
  }

  private loginBlocked(email: string) {
    const entry = this.failedLogins.get(email);
    if (entry && entry.resetAt < Date.now()) this.failedLogins.delete(email);
    return (this.failedLogins.get(email)?.count ?? 0) >= MAX_FAILED_LOGINS;
  }

  private recordFailedLogin(email: string) {
    const entry = this.failedLogins.get(email) ?? { count: 0, resetAt: Date.now() + LOGIN_WINDOW_MS };
    entry.count++;
    this.failedLogins.set(email, entry);
  }

  async login(input: z.infer<typeof loginSchema>) {
    if (this.loginBlocked(input.email)) throw new AppError(429, 'TOO_MANY_ATTEMPTS', 'Çok fazla hatalı deneme; 15 dakika sonra tekrar deneyin');
    const user = await this.prisma.user.findUnique({ where: { email: input.email } });
    if (!user || !(await argon2.verify(user.passwordHash, input.password))) {
      this.recordFailedLogin(input.email);
      throw new AppError(401, 'INVALID_CREDENTIALS', 'E-posta veya şifre hatalı');
    }
    this.failedLogins.delete(input.email);
    await this.prisma.user.update({ where: { id: user.id }, data: { lastSeenAt: new Date() } });
    return this.issueTokens(user.id, user.email, user.isAdmin);
  }

  async refresh(refreshToken: string) {
    const session = await this.prisma.session.findUnique({ where: { tokenHash: sha256(refreshToken) }, include: { user: true } });
    if (!session || session.revokedAt || session.expiresAt < new Date())
      throw new AppError(401, 'REFRESH_INVALID', 'Oturum yenilenemedi, tekrar giriş yapın');
    await this.prisma.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
    return this.issueTokens(session.user.id, session.user.email, session.user.isAdmin);
  }

  async logout(refreshToken: string) {
    await this.prisma.session.updateMany({ where: { tokenHash: sha256(refreshToken) }, data: { revokedAt: new Date() } });
    return { ok: true };
  }

  private async issueTokens(userId: string, email: string, isAdmin: boolean, tx?: any) {
    const db = tx ?? this.prisma;
    const accessToken = await this.jwt.signAsync({ sub: userId, email, adm: isAdmin, typ: 'access' });
    const refreshToken = randomToken(32);
    await db.session.create({
      data: {
        userId,
        tokenHash: sha256(refreshToken),
        expiresAt: new Date(Date.now() + env().REFRESH_TTL_DAYS * 86400_000),
      },
    });
    return { accessToken, refreshToken, expiresIn: env().JWT_ACCESS_TTL_SECONDS };
  }

  async me(ctx: RequestContext) {
    const [user, workspace, telegram] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({ where: { id: ctx.userId } }),
      this.prisma.workspace.findUniqueOrThrow({ where: { id: ctx.workspaceId } }),
      this.prisma.telegramLink.findUnique({ where: { userId: ctx.userId } }),
    ]);
    await this.prisma.user.update({ where: { id: ctx.userId }, data: { lastSeenAt: new Date() } });
    return {
      user: { id: user.id, email: user.email, displayName: user.displayName, isAdmin: user.isAdmin, notificationSettings: user.notificationSettings },
      workspace,
      telegramLinked: !!telegram,
    };
  }

  async updateMe(ctx: RequestContext, input: z.infer<typeof meSchema>) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: ctx.userId } });
    const settings = { ...(user.notificationSettings as object), ...(input.notificationSettings ?? {}) };
    await this.prisma.user.update({
      where: { id: ctx.userId },
      data: { displayName: input.displayName ?? user.displayName, notificationSettings: settings },
    });
    return this.me(ctx);
  }

  async changePassword(ctx: RequestContext, input: z.infer<typeof passwordSchema>) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: ctx.userId } });
    if (!(await argon2.verify(user.passwordHash, input.currentPassword))) throw new AppError(400, 'PASSWORD_WRONG', 'Mevcut şifre hatalı');
    await this.prisma.user.update({ where: { id: user.id }, data: { passwordHash: await argon2.hash(input.newPassword) } });
    await this.audit.log({ workspaceId: ctx.workspaceId, actorId: ctx.userId, action: 'user.password_change', entityType: 'User', entityId: user.id });
    return { ok: true };
  }

  async listUsers() {
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const users = await this.prisma.user.findMany({ orderBy: { createdAt: 'asc' }, select: { id: true, email: true, displayName: true, isAdmin: true, createdAt: true, lastSeenAt: true, memberships: { select: { workspaceId: true } } } });
    const usage = await this.prisma.aiTask.groupBy({ by: ['workspaceId'], where: { createdAt: { gte: dayStart }, provider: { notIn: ['manual', 'template'] } }, _count: true });
    const today = new Map(usage.map((u) => [u.workspaceId, u._count]));
    return users.map(({ memberships, ...u }) => ({ ...u, aiTasksToday: memberships.reduce((sum, m) => sum + (today.get(m.workspaceId) ?? 0), 0) }));
  }

  async resetPassword(ctx: RequestContext, userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new AppError(404, 'NOT_FOUND', 'Kullanıcı bulunamadı');
    const temporaryPassword = randomCode(TEMP_PASSWORD_LENGTH);
    await this.prisma.user.update({ where: { id: userId }, data: { passwordHash: await argon2.hash(temporaryPassword) } });
    await this.prisma.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
    this.failedLogins.delete(user.email);
    await this.audit.log({ workspaceId: ctx.workspaceId, actorId: ctx.userId, action: 'user.password_reset', entityType: 'User', entityId: userId });
    return { email: user.email, temporaryPassword };
  }

  async createInvite(ctx: RequestContext, input: z.infer<typeof inviteSchema>) {
    const invite = await this.prisma.invite.create({
      data: {
        code: randomCode(10),
        issuedById: ctx.userId,
        email: input.email?.toLowerCase(),
        expiresAt: new Date(Date.now() + input.days * 86400_000),
      },
    });
    await this.audit.log({ workspaceId: ctx.workspaceId, actorId: ctx.userId, action: 'invite.create', entityType: 'Invite', entityId: invite.id });
    return invite;
  }

  listInvites(ctx: RequestContext) {
    return this.prisma.invite.findMany({ where: { issuedById: ctx.userId }, orderBy: { createdAt: 'desc' }, take: 50 });
  }
}

@Controller('v1')
export class AuthController {
  constructor(private readonly svc: AuthService) {}

  @Public()
  @Get('auth/status')
  status() {
    return this.svc.status();
  }

  @Public()
  @Post('auth/register')
  register(@Body(new ZodPipe(registerSchema)) body: z.infer<typeof registerSchema>) {
    return this.svc.register(body);
  }

  @Public()
  @Post('auth/login')
  login(@Body(new ZodPipe(loginSchema)) body: z.infer<typeof loginSchema>) {
    return this.svc.login(body);
  }

  @Public()
  @Post('auth/refresh')
  refresh(@Body(new ZodPipe(refreshSchema)) body: z.infer<typeof refreshSchema>) {
    return this.svc.refresh(body.refreshToken);
  }

  @Public()
  @Post('auth/logout')
  logout(@Body(new ZodPipe(refreshSchema)) body: z.infer<typeof refreshSchema>) {
    return this.svc.logout(body.refreshToken);
  }

  @Get('me')
  me(@Ctx() ctx: RequestContext) {
    return this.svc.me(ctx);
  }

  @Patch('me')
  updateMe(@Ctx() ctx: RequestContext, @Body(new ZodPipe(meSchema)) body: z.infer<typeof meSchema>) {
    return this.svc.updateMe(ctx, body);
  }

  @Post('me/password')
  changePassword(@Ctx() ctx: RequestContext, @Body(new ZodPipe(passwordSchema)) body: z.infer<typeof passwordSchema>) {
    return this.svc.changePassword(ctx, body);
  }

  @AdminOnly()
  @Get('admin/users')
  users() {
    return this.svc.listUsers();
  }

  @AdminOnly()
  @Post('admin/users/:id/reset-password')
  resetPassword(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.svc.resetPassword(ctx, id);
  }

  @AdminOnly()
  @Post('invites')
  createInvite(@Ctx() ctx: RequestContext, @Body(new ZodPipe(inviteSchema)) body: z.infer<typeof inviteSchema>) {
    return this.svc.createInvite(ctx, body);
  }

  @AdminOnly()
  @Get('invites')
  invites(@Ctx() ctx: RequestContext) {
    return this.svc.listInvites(ctx);
  }
}

@Module({ controllers: [AuthController], providers: [AuthService], exports: [AuthService] })
export class AuthModule {}
