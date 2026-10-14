import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { AppError } from './errors';
import { PrismaService } from './prisma.service';

export interface RequestContext {
  userId: string;
  email: string;
  isAdmin: boolean;
  workspaceId: string;
  role: string;
}

export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);
export const ADMIN_ONLY = 'adminOnly';
export const AdminOnly = () => SetMetadata(ADMIN_ONLY, true);

export const Ctx = createParamDecorator((_: unknown, ctx: ExecutionContext): RequestContext => {
  return ctx.switchToHttp().getRequest().ctx;
});

/**
 * Tüm uçlarda kimlik doğrulama + workspace sınırı. Workspace istemci filtresinden değil,
 * kullanıcının üyeliğinden sunucuda çözülür.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;
    const req = context.switchToHttp().getRequest();
    const header: string | undefined = req.headers['authorization'];
    let token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    // SSE/EventSource başlık gönderemediği için yalnızca /events uçlarında query token kabul edilir.
    if (!token && typeof req.query?.access_token === 'string' && req.path?.includes('/events')) {
      token = req.query.access_token;
    }
    if (!token) throw new AppError(401, 'UNAUTHENTICATED', 'Oturum gerekli');
    let payload: { sub?: unknown; email: string; adm?: boolean; typ?: string };
    try {
      payload = await this.jwt.verifyAsync(token);
    } catch {
      throw new AppError(401, 'TOKEN_INVALID', 'Oturum süresi doldu veya geçersiz');
    }
    // Yalnızca erişim token'ı kabul edilir (OAuth state vb. imzalı değerler oturum yerine geçemez).
    if (payload.typ !== 'access' || typeof payload.sub !== 'string' || !payload.sub) {
      throw new AppError(401, 'TOKEN_INVALID', 'Oturum süresi doldu veya geçersiz');
    }
    const requestedWs = req.headers['x-workspace-id'] as string | undefined;
    const membership = await this.prisma.membership.findFirst({
      where: { userId: payload.sub as string, ...(requestedWs ? { workspaceId: requestedWs } : {}) },
      orderBy: { createdAt: 'asc' },
      include: { user: true },
    });
    if (!membership) throw new AppError(403, 'NO_WORKSPACE', 'Workspace erişimi yok');
    req.ctx = {
      userId: payload.sub as string,
      email: membership.user.email,
      isAdmin: membership.user.isAdmin,
      workspaceId: membership.workspaceId,
      role: membership.role,
    } satisfies RequestContext;
    const adminOnly = this.reflector.getAllAndOverride<boolean>(ADMIN_ONLY, [context.getHandler(), context.getClass()]);
    if (adminOnly && !membership.user.isAdmin) throw new AppError(403, 'ADMIN_ONLY', 'Yalnızca sunucu yöneticisi');
    return true;
  }
}
