import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker/worker.module';
import { WorkerService } from './worker/worker.service';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule, { logger: ['error', 'warn', 'log'] });
  app.enableShutdownHooks();
  await app.get(WorkerService).start();
  new Logger('Worker').log('Kuyruk çalışanları hazır');
}

bootstrap().catch((e) => {
  console.error(e);
  process.exit(1);
});
