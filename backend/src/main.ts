import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NextFunction, Request, Response } from 'express';
import { existsSync } from 'fs';
import * as path from 'path';
import { AppModule } from './app.module';
import { env } from './common/env';
import { AllExceptionsFilter } from './common/http-exception.filter';

export async function createApp() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true, logger: ['error', 'warn', 'log'] });
  app.setGlobalPrefix('api');
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useBodyParser('json', { limit: '2mb' });
  const origins = [env().APP_PUBLIC_URL.replace(/\/$/, ''), 'http://localhost:8080', 'http://localhost:5173', 'http://127.0.0.1:8080'];
  app.enableCors({ origin: (o: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => cb(null, !o || origins.includes(o) || /^http:\/\/localhost:\d+$/.test(o)), credentials: false });
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  // Docker/Caddy olmadan tek süreçte çalıştırma: derlenmiş web arayüzü API ile aynı origin'den sunulur.
  // Arayüz rotaları (/profile vb.) kabuğa düşer; /api ve dosya uzantılı istekler düşmez.
  const webDir = process.env.WEB_DIR ? path.resolve(process.env.WEB_DIR) : null;
  if (webDir && existsSync(path.join(webDir, 'index.html'))) {
    app.useStaticAssets(webDir, { index: 'index.html', maxAge: 0 });
    app.use((req: Request, res: Response, next: NextFunction) => {
      const isUiRoute = req.method === 'GET' && !req.path.startsWith('/api') && !path.extname(req.path);
      return isUiRoute ? res.sendFile(path.join(webDir, 'index.html')) : next();
    });
  }
  const doc = SwaggerModule.createDocument(
    app,
    new DocumentBuilder().setTitle('Jobless Turtle API').setVersion('1.0.0').addBearerAuth().build(),
  );
  SwaggerModule.setup('api/docs', app, doc);
  return app;
}

async function bootstrap() {
  const app = await createApp();
  app.enableShutdownHooks();
  await app.listen(env().PORT, '0.0.0.0');
  new Logger('API').log(`API http://0.0.0.0:${env().PORT}/api (dokümantasyon: /api/docs)`);
}

if (require.main === module) {
  bootstrap().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
