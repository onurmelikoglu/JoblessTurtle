import { HttpException } from '@nestjs/common';

/**
 * Kullanıcıya okunur gerekçe koduyla dönen hata.
 * Örnek kodlar: CONTACT_UNVERIFIED, SOURCE_BLOCKED, ALREADY_APPLIED, DOCUMENT_CHANGED, CHANNEL_MANUAL_ONLY.
 */
export class AppError extends HttpException {
  constructor(
    status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super({ error: { code, message, details } }, status);
  }
}

export const notFound = (what = 'Kayıt') => new AppError(404, 'NOT_FOUND', `${what} bulunamadı`);
export const forbidden = (message = 'Bu işlem için yetkiniz yok') => new AppError(403, 'FORBIDDEN', message);
export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, 'BAD_REQUEST', message, details);
export const conflict = (code: string, message: string, details?: unknown) =>
  new AppError(409, code, message, details);
export const unprocessable = (code: string, message: string, details?: unknown) =>
  new AppError(422, code, message, details);

export function errorMessage(e: unknown): string {
  if (e instanceof AppError) {
    const body = e.getResponse() as { error?: { message?: string } };
    return body.error?.message ?? e.code;
  }
  return e instanceof Error ? e.message : String(e);
}
