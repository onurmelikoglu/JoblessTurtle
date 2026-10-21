import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './common/auth';
import { CommonModule } from './common/common.module';
import { EngineModule } from './engine/engine.module';
import { AiModule } from './modules/ai/ai.module';
import { ApplicationsModule } from './modules/applications/applications.module';
import { AuthModule } from './modules/auth/auth.module';
import { CandidatesModule } from './modules/candidates/candidates.module';
import { CompaniesModule } from './modules/companies/companies.module';
import { DocumentsModule } from './modules/documents/documents.module';
import { HomeModule } from './modules/home/home.module';
import { ImportsModule } from './modules/imports/imports.module';
import { JobsModule } from './modules/jobs/jobs.module';
import { MailModule } from './modules/mail/mail.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { ScrapersModule } from './modules/scrapers/scrapers.module';
import { SourcesModule } from './modules/sources/sources.module';
import { SystemModule } from './modules/system/system.module';
import { WorkspaceModule } from './modules/workspace/workspace.module';

@Module({
  imports: [
    CommonModule,
    EngineModule,
    AuthModule,
    WorkspaceModule,
    CandidatesModule,
    CompaniesModule,
    SourcesModule,
    ScrapersModule,
    JobsModule,
    DocumentsModule,
    ImportsModule,
    ApplicationsModule,
    MailModule,
    NotificationsModule,
    AiModule,
    HomeModule,
    SystemModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
})
export class AppModule {}
