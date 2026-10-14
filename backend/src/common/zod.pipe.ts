import { PipeTransform } from '@nestjs/common';
import { ZodSchema } from 'zod';
import { AppError } from './errors';

export class ZodPipe<T> implements PipeTransform {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(value: unknown): T {
    const parsed = this.schema.safeParse(value ?? {});
    if (!parsed.success) {
      throw new AppError(400, 'VALIDATION_FAILED', 'Gönderilen veri geçersiz', parsed.error.flatten());
    }
    return parsed.data;
  }
}
