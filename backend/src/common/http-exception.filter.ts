import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP');

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse() as any;
      if (body && typeof body === 'object' && body.error?.code) {
        res.status(status).json(body);
        return;
      }
      const message = typeof body === 'string' ? body : Array.isArray(body?.message) ? body.message.join(', ') : body?.message;
      res.status(status).json({ error: { code: httpCode(status), message: message ?? exception.message } });
      return;
    }
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') {
        res.status(409).json({ error: { code: 'UNIQUE_CONFLICT', message: 'Aynı kayıt zaten mevcut', details: exception.meta } });
        return;
      }
      if (exception.code === 'P2025') {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Kayıt bulunamadı' } });
        return;
      }
    }
    // Log içinde mail gövdesi / token / CV metni bulunmaması için yalnızca mesaj ve tür loglanır.
    const err = exception as Error;
    this.logger.error(`${err?.name}: ${err?.message}`, err?.stack?.split('\n').slice(0, 4).join('\n'));
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Beklenmeyen bir hata oluştu' } });
  }
}

function httpCode(status: number) {
  switch (status) {
    case 400:
      return 'BAD_REQUEST';
    case 401:
      return 'UNAUTHENTICATED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 413:
      return 'PAYLOAD_TOO_LARGE';
    case 422:
      return 'UNPROCESSABLE';
    case 429:
      return 'RATE_LIMITED';
    default:
      return 'ERROR';
  }
}
