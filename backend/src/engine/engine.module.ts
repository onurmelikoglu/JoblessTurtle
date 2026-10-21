import { Global, Module } from '@nestjs/common';
import { ActivityService } from './activity.service';
import { AddressBookService } from './address-book.service';
import { AiService } from './ai/ai.service';
import { AutomationService } from './automation.service';
import { AutopilotService } from './autopilot.service';
import { CandidateFactsService } from './candidate-facts.service';
import { CatalogService } from './catalog.service';
import { CompanyScoringService } from './company-scoring.service';
import { DraftingService } from './drafting.service';
import { EvaluationService } from './evaluation.service';
import { InboxService } from './inbox.service';
import { IngestService } from './ingest.service';
import { JobAlertsService } from './job-alerts.service';
import { JobSearchService } from './job-search.service';
import { LearnedModelsService } from './learned-models.service';
import { LearningService } from './learning.service';
import { LetterService } from './letter.service';
import { NotifyService } from './notify.service';
import { RepliesService } from './replies.service';
import { ResearchService } from './research.service';
import { ScraperService } from './scraper.service';
import { ScrapedJobRepository } from './scrapers/scraped-job.repository';
import { SendingService } from './sending.service';
import { TelegramService } from './telegram.service';

const SERVICES = [
  ActivityService,
  AddressBookService,
  AiService,
  AutomationService,
  AutopilotService,
  CandidateFactsService,
  CatalogService,
  CompanyScoringService,
  DraftingService,
  EvaluationService,
  InboxService,
  IngestService,
  JobAlertsService,
  JobSearchService,
  LearnedModelsService,
  LearningService,
  LetterService,
  NotifyService,
  RepliesService,
  ResearchService,
  ScrapedJobRepository,
  ScraperService,
  SendingService,
  TelegramService,
];

/** API ve worker'ın ortak kullandığı iş kuralları katmanı. */
@Global()
@Module({ providers: SERVICES, exports: SERVICES })
export class EngineModule {}
