import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { EngineModule } from '../engine/engine.module';
import { WorkerService } from './worker.service';

@Module({ imports: [CommonModule, EngineModule], providers: [WorkerService], exports: [WorkerService] })
export class WorkerModule {}
