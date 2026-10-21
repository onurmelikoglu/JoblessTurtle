-- CreateTable
CREATE TABLE "ScrapedJob" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "similarityKey" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "jobTitle" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "district" TEXT,
    "jobUrl" TEXT NOT NULL,
    "companyUrl" TEXT,
    "description" TEXT,
    "employmentType" TEXT,
    "workMode" TEXT,
    "publishedAt" TIMESTAMP(3),
    "publishedText" TEXT,
    "contentHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "duplicateOfId" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "contentChangedAt" TIMESTAMP(3),
    "firstRunId" TEXT,
    "lastRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScrapedJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScraperRun" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "trigger" TEXT NOT NULL DEFAULT 'schedule',
    "state" TEXT NOT NULL DEFAULT 'queued',
    "cities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "keywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "maxPages" INTEGER NOT NULL DEFAULT 1,
    "pagesVisited" INTEGER NOT NULL DEFAULT 0,
    "pagesFailed" INTEGER NOT NULL DEFAULT 0,
    "listingsFound" INTEGER NOT NULL DEFAULT 0,
    "listingsNew" INTEGER NOT NULL DEFAULT 0,
    "listingsUpdated" INTEGER NOT NULL DEFAULT 0,
    "duplicates" INTEGER NOT NULL DEFAULT 0,
    "forwarded" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB NOT NULL DEFAULT '[]',
    "errorSummary" TEXT,
    "requestedById" TEXT,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "ScraperRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ScrapedJob_source_externalId_key" ON "ScrapedJob"("source", "externalId");

-- CreateIndex
CREATE INDEX "ScrapedJob_source_status_lastSeenAt_idx" ON "ScrapedJob"("source", "status", "lastSeenAt");

-- CreateIndex
CREATE INDEX "ScrapedJob_firstSeenAt_idx" ON "ScrapedJob"("firstSeenAt");

-- CreateIndex
CREATE INDEX "ScrapedJob_similarityKey_idx" ON "ScrapedJob"("similarityKey");

-- CreateIndex
CREATE INDEX "ScraperRun_source_queuedAt_idx" ON "ScraperRun"("source", "queuedAt");

-- CreateIndex
CREATE INDEX "ScraperRun_state_idx" ON "ScraperRun"("state");
