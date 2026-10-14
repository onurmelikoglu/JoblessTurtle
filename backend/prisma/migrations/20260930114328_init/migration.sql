-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "isAdmin" BOOLEAN NOT NULL DEFAULT false,
    "notificationSettings" JSONB NOT NULL DEFAULT '{}',
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invite" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "issuedById" TEXT NOT NULL,
    "email" TEXT,
    "usedByEmail" TEXT,
    "usedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Istanbul',
    "automationPaused" BOOLEAN NOT NULL DEFAULT false,
    "pausedAt" TIMESTAMP(3),
    "pausedReason" TEXT,
    "aiSettings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Membership" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'owner',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CandidateProfile" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "headline" TEXT,
    "city" TEXT,
    "verifiedFacts" JSONB NOT NULL DEFAULT '[]',
    "languages" JSONB NOT NULL DEFAULT '[]',
    "experienceYears" INTEGER,
    "teamManagement" BOOLEAN,
    "workModes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "employmentTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "workPermit" TEXT,
    "portfolioUrl" TEXT,
    "portfolioItems" JSONB NOT NULL DEFAULT '[]',
    "signature" TEXT,
    "consentVersion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CandidateProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SearchProfile" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "exactTitles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "adjacentTitles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "excludedTitles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sectors" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "excludedSectors" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "keywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "city" TEXT,
    "districtsPrimary" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "districtsConditional" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "allowRemote" BOOLEAN NOT NULL DEFAULT false,
    "allowHybrid" BOOLEAN NOT NULL DEFAULT true,
    "unknownLocationAction" TEXT NOT NULL DEFAULT 'review',
    "autoIncludeAdjacent" BOOLEAN NOT NULL DEFAULT false,
    "requiredConditions" JSONB NOT NULL DEFAULT '[]',
    "qWeights" JSONB,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SearchProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourceConnector" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "companyId" TEXT,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "accessMode" TEXT NOT NULL DEFAULT 'api',
    "capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "permissionEvidence" TEXT,
    "permissionCheckedAt" TIMESTAMP(3),
    "isOfficial" BOOLEAN NOT NULL DEFAULT true,
    "minIntervalMinutes" INTEGER NOT NULL DEFAULT 10,
    "intervalMinutes" INTEGER NOT NULL DEFAULT 10,
    "quotaPerDay" INTEGER,
    "health" TEXT NOT NULL DEFAULT 'unknown',
    "healthReason" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "etag" TEXT,
    "lastModified" TEXT,
    "lastContentHash" TEXT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "lastRunAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3),
    "backoffUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SourceConnector_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrawlRun" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL DEFAULT 'schedule',
    "state" TEXT NOT NULL DEFAULT 'running',
    "complete" BOOLEAN NOT NULL DEFAULT false,
    "pages" INTEGER NOT NULL DEFAULT 0,
    "listingsSeen" INTEGER NOT NULL DEFAULT 0,
    "listingsNew" INTEGER NOT NULL DEFAULT 0,
    "listingsClosed" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "metrics" JSONB NOT NULL DEFAULT '{}',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "CrawlRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourceObservation" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sourceId" TEXT,
    "crawlRunId" TEXT,
    "sourceUrl" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "responseState" TEXT NOT NULL,
    "httpStatus" INTEGER,
    "extractorVersion" TEXT NOT NULL,
    "contentHash" TEXT,
    "permittedSnapshot" JSONB,
    "coverage" TEXT NOT NULL DEFAULT 'full',

    CONSTRAINT "SourceObservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Company" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "canonicalDomain" TEXT,
    "legalName" TEXT,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "groupName" TEXT,
    "sectors" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "services" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "description" TEXT,
    "website" TEXT,
    "careersUrl" TEXT,
    "notes" TEXT,
    "origin" TEXT NOT NULL DEFAULT 'manual',
    "importRef" TEXT,
    "qualityDims" JSONB NOT NULL DEFAULT '{}',
    "qScore" DOUBLE PRECISION,
    "qCoverage" DOUBLE PRECISION,
    "watch" BOOLEAN NOT NULL DEFAULT false,
    "researchReport" JSONB,
    "lastResearchedAt" TIMESTAMP(3),
    "excluded" BOOLEAN NOT NULL DEFAULT false,
    "excludedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Office" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "label" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'office',
    "address" TEXT,
    "city" TEXT,
    "district" TEXT,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "locationConfidence" TEXT NOT NULL DEFAULT 'medium',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Office_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyEvidence" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "dimension" TEXT NOT NULL,
    "customerName" TEXT,
    "scope" TEXT NOT NULL DEFAULT 'unknown',
    "claimType" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "url" TEXT,
    "evidenceDate" TIMESTAMP(3),
    "confidence" TEXT NOT NULL DEFAULT 'medium',
    "createdBy" TEXT NOT NULL DEFAULT 'user',
    "accepted" BOOLEAN NOT NULL DEFAULT true,
    "aiTaskId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompanyEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "canonicalKey" TEXT NOT NULL,
    "requisitionId" TEXT,
    "title" TEXT NOT NULL,
    "normalizedTitle" TEXT NOT NULL,
    "roleScope" TEXT,
    "officeId" TEXT,
    "locationText" TEXT,
    "district" TEXT,
    "city" TEXT,
    "workMode" TEXT NOT NULL DEFAULT 'unknown',
    "status" TEXT NOT NULL DEFAULT 'unknown',
    "statusReason" TEXT,
    "openCycle" INTEGER NOT NULL DEFAULT 1,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastVerifiedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "description" TEXT,
    "applyEmail" TEXT,
    "applyUrl" TEXT,
    "channel" TEXT NOT NULL DEFAULT 'unknown',
    "conflict" JSONB,
    "mergeReview" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobListing" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "canonicalUrl" TEXT,
    "isOfficial" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'open',
    "statusReason" TEXT,
    "title" TEXT NOT NULL,
    "locationText" TEXT,
    "applyUrl" TEXT,
    "applyEmail" TEXT,
    "postedAt" TIMESTAMP(3),
    "sourceUpdatedAt" TIMESTAMP(3),
    "validThrough" TIMESTAMP(3),
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastVerifiedAt" TIMESTAMP(3),
    "missingCount" INTEGER NOT NULL DEFAULT 0,
    "contentHash" TEXT,
    "openCycle" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobListing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobSnapshot" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "observationId" TEXT,
    "title" TEXT NOT NULL,
    "normalizedFields" JSONB NOT NULL DEFAULT '{}',
    "diff" JSONB,
    "status" TEXT NOT NULL,
    "statusReason" TEXT,
    "openCycle" INTEGER NOT NULL DEFAULT 1,
    "contentHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Opportunity" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "searchProfileId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "jobId" TEXT,
    "key" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "titleMatch" TEXT NOT NULL DEFAULT 'none',
    "q" DOUBLE PRECISION,
    "f" DOUBLE PRECISION,
    "coverage" DOUBLE PRECISION,
    "fBreakdown" JSONB NOT NULL DEFAULT '{}',
    "mandatoryUnknown" BOOLEAN NOT NULL DEFAULT false,
    "locationState" TEXT NOT NULL DEFAULT 'unknown',
    "reasons" JSONB NOT NULL DEFAULT '[]',
    "evidenceIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'new',
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Opportunity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactPoint" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT,
    "role" TEXT,
    "email" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "purpose" TEXT,
    "sourceUrl" TEXT,
    "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedAt" TIMESTAMP(3),
    "verifiedBy" TEXT,
    "ownershipEvidence" TEXT,
    "confidence" TEXT NOT NULL DEFAULT 'medium',
    "suppressed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContactPoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailAccount" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "accountEmail" TEXT NOT NULL,
    "displayName" TEXT,
    "scopeSet" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "encryptedSecret" TEXT,
    "smtpHost" TEXT,
    "smtpPort" INTEGER,
    "smtpSecure" BOOLEAN NOT NULL DEFAULT true,
    "smtpUser" TEXT,
    "health" TEXT NOT NULL DEFAULT 'ok',
    "healthReason" TEXT,
    "dailyLimit" INTEGER NOT NULL DEFAULT 20,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentVersion" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'tr',
    "label" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "scanState" TEXT NOT NULL DEFAULT 'pending',
    "scanReason" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApplicationDraft" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "opportunityId" TEXT,
    "companyId" TEXT NOT NULL,
    "jobId" TEXT,
    "contactId" TEXT,
    "campaignId" TEXT,
    "followUpOfId" TEXT,
    "intentType" TEXT NOT NULL,
    "mailAccountId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "origin" TEXT NOT NULL DEFAULT 'manual',
    "currentRevision" INTEGER NOT NULL DEFAULT 0,
    "blockedReasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApplicationDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DraftRevision" (
    "id" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "toEmail" TEXT,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "documentIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "links" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sourceRefs" JSONB NOT NULL DEFAULT '[]',
    "hash" TEXT NOT NULL,
    "generator" TEXT NOT NULL DEFAULT 'user',
    "aiTaskId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DraftRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationPolicy" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "searchProfileId" TEXT NOT NULL,
    "mailAccountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "modeJobApplication" BOOLEAN NOT NULL DEFAULT false,
    "modeGeneralIntent" BOOLEAN NOT NULL DEFAULT false,
    "modeFollowUp" BOOLEAN NOT NULL DEFAULT false,
    "includeAdjacent" BOOLEAN NOT NULL DEFAULT false,
    "fMin" DOUBLE PRECISION NOT NULL DEFAULT 85,
    "qMin" DOUBLE PRECISION NOT NULL DEFAULT 65,
    "coverageMin" DOUBLE PRECISION NOT NULL DEFAULT 0.6,
    "allowedRecipientKinds" TEXT[] DEFAULT ARRAY['official_hr', 'job_apply']::TEXT[],
    "documentIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "dailyLimit" INTEGER NOT NULL DEFAULT 10,
    "intentDailyLimit" INTEGER NOT NULL DEFAULT 3,
    "companyCooldownDays" INTEGER NOT NULL DEFAULT 30,
    "sendWindowStart" TEXT NOT NULL DEFAULT '09:00',
    "sendWindowEnd" TEXT NOT NULL DEFAULT '18:00',
    "sendDays" INTEGER[] DEFAULT ARRAY[1, 2, 3, 4, 5]::INTEGER[],
    "sendImmediately" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "enabledAt" TIMESTAMP(3),
    "disabledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutomationPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationPolicyVersion" (
    "id" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "reason" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutomationPolicyVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApplicationAttempt" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "draftRevision" INTEGER NOT NULL,
    "draftHash" TEXT NOT NULL,
    "policyVersionId" TEXT,
    "campaignId" TEXT,
    "companyId" TEXT NOT NULL,
    "jobId" TEXT,
    "jobCanonicalKey" TEXT,
    "intentType" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'email',
    "sendMode" TEXT NOT NULL,
    "mailAccountId" TEXT,
    "toEmail" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "activeKey" TEXT,
    "state" TEXT NOT NULL DEFAULT 'queued',
    "stateReason" TEXT,
    "documentHashes" JSONB NOT NULL DEFAULT '[]',
    "sentPayloadHash" TEXT,
    "providerMessageId" TEXT,
    "providerThreadId" TEXT,
    "outcome" TEXT,
    "notes" TEXT,
    "scheduledAt" TIMESTAMP(3),
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sendingAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApplicationAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "mailAccountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "intentType" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'draft',
    "documentIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "subjectTemplate" TEXT,
    "bodyTemplate" TEXT,
    "startedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FollowUp" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "cancellationReason" TEXT,
    "draftId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FollowUp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageCounter" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "UsageCounter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT,
    "eventType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "dedupKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "processingState" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT,
    "actorId" TEXT,
    "actorType" TEXT NOT NULL DEFAULT 'user',
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "reason" TEXT,
    "previous" JSONB,
    "next" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboundMessage" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "mailAccountId" TEXT,
    "attemptId" TEXT,
    "providerMessageId" TEXT NOT NULL,
    "threadId" TEXT,
    "fromEmail" TEXT,
    "subject" TEXT,
    "snippet" TEXT,
    "classification" TEXT NOT NULL DEFAULT 'unknown',
    "source" TEXT NOT NULL DEFAULT 'manual',
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InboundMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT,
    "eventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "link" TEXT,
    "channel" TEXT NOT NULL DEFAULT 'in_app',
    "deliveredAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Suppression" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "candidateId" TEXT,
    "companyId" TEXT,
    "contactEmail" TEXT,
    "domain" TEXT,
    "channel" TEXT,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Suppression_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelegramLink" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "username" TEXT,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelegramLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelegramLinkCode" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelegramLinkCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KeyValue" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KeyValue_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "AiTask" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "inputHash" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "output" JSONB,
    "rawOutput" TEXT,
    "error" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "context" JSONB NOT NULL DEFAULT '{}',
    "createdById" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportJob" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'preview',
    "sheets" JSONB NOT NULL DEFAULT '[]',
    "mapping" JSONB,
    "stats" JSONB,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Invite_code_key" ON "Invite"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_workspaceId_userId_key" ON "Membership"("workspaceId", "userId");

-- CreateIndex
CREATE INDEX "CandidateProfile_workspaceId_idx" ON "CandidateProfile"("workspaceId");

-- CreateIndex
CREATE INDEX "SearchProfile_workspaceId_idx" ON "SearchProfile"("workspaceId");

-- CreateIndex
CREATE INDEX "SourceConnector_workspaceId_idx" ON "SourceConnector"("workspaceId");

-- CreateIndex
CREATE INDEX "SourceConnector_enabled_nextRunAt_idx" ON "SourceConnector"("enabled", "nextRunAt");

-- CreateIndex
CREATE INDEX "CrawlRun_sourceId_startedAt_idx" ON "CrawlRun"("sourceId", "startedAt");

-- CreateIndex
CREATE INDEX "SourceObservation_workspaceId_fetchedAt_idx" ON "SourceObservation"("workspaceId", "fetchedAt");

-- CreateIndex
CREATE INDEX "Company_workspaceId_normalizedName_idx" ON "Company"("workspaceId", "normalizedName");

-- CreateIndex
CREATE UNIQUE INDEX "Company_workspaceId_canonicalDomain_key" ON "Company"("workspaceId", "canonicalDomain");

-- CreateIndex
CREATE INDEX "CompanyEvidence_companyId_idx" ON "CompanyEvidence"("companyId");

-- CreateIndex
CREATE INDEX "Job_workspaceId_status_idx" ON "Job"("workspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Job_workspaceId_canonicalKey_key" ON "Job"("workspaceId", "canonicalKey");

-- CreateIndex
CREATE INDEX "JobListing_jobId_idx" ON "JobListing"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "JobListing_sourceId_externalId_key" ON "JobListing"("sourceId", "externalId");

-- CreateIndex
CREATE INDEX "JobSnapshot_listingId_createdAt_idx" ON "JobSnapshot"("listingId", "createdAt");

-- CreateIndex
CREATE INDEX "Opportunity_workspaceId_category_idx" ON "Opportunity"("workspaceId", "category");

-- CreateIndex
CREATE UNIQUE INDEX "Opportunity_searchProfileId_key_key" ON "Opportunity"("searchProfileId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "ContactPoint_companyId_email_key" ON "ContactPoint"("companyId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "MailAccount_candidateId_provider_accountEmail_key" ON "MailAccount"("candidateId", "provider", "accountEmail");

-- CreateIndex
CREATE INDEX "DocumentVersion_candidateId_type_idx" ON "DocumentVersion"("candidateId", "type");

-- CreateIndex
CREATE INDEX "ApplicationDraft_workspaceId_status_idx" ON "ApplicationDraft"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "ApplicationDraft_campaignId_idx" ON "ApplicationDraft"("campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "DraftRevision_draftId_revision_key" ON "DraftRevision"("draftId", "revision");

-- CreateIndex
CREATE INDEX "AutomationPolicy_workspaceId_active_idx" ON "AutomationPolicy"("workspaceId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "AutomationPolicyVersion_policyId_version_key" ON "AutomationPolicyVersion"("policyId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "ApplicationAttempt_activeKey_key" ON "ApplicationAttempt"("activeKey");

-- CreateIndex
CREATE INDEX "ApplicationAttempt_workspaceId_state_idx" ON "ApplicationAttempt"("workspaceId", "state");

-- CreateIndex
CREATE INDEX "ApplicationAttempt_candidateId_companyId_createdAt_idx" ON "ApplicationAttempt"("candidateId", "companyId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ApplicationAttempt_workspaceId_idempotencyKey_key" ON "ApplicationAttempt"("workspaceId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "FollowUp_attemptId_key" ON "FollowUp"("attemptId");

-- CreateIndex
CREATE UNIQUE INDEX "UsageCounter_workspaceId_key_day_key" ON "UsageCounter"("workspaceId", "key", "day");

-- CreateIndex
CREATE UNIQUE INDEX "OutboxEvent_dedupKey_key" ON "OutboxEvent"("dedupKey");

-- CreateIndex
CREATE INDEX "OutboxEvent_processingState_availableAt_idx" ON "OutboxEvent"("processingState", "availableAt");

-- CreateIndex
CREATE INDEX "AuditEvent_workspaceId_createdAt_idx" ON "AuditEvent"("workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "InboundMessage_workspaceId_providerMessageId_key" ON "InboundMessage"("workspaceId", "providerMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_provider_eventId_key" ON "WebhookEvent"("provider", "eventId");

-- CreateIndex
CREATE INDEX "Notification_workspaceId_createdAt_idx" ON "Notification"("workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_eventId_channel_key" ON "Notification"("eventId", "channel");

-- CreateIndex
CREATE INDEX "Suppression_workspaceId_idx" ON "Suppression"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramLink_userId_key" ON "TelegramLink"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramLink_chatId_key" ON "TelegramLink"("chatId");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramLinkCode_code_key" ON "TelegramLinkCode"("code");

-- CreateIndex
CREATE INDEX "AiTask_workspaceId_status_idx" ON "AiTask"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "AiTask_workspaceId_kind_inputHash_idx" ON "AiTask"("workspaceId", "kind", "inputHash");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invite" ADD CONSTRAINT "Invite_issuedById_fkey" FOREIGN KEY ("issuedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SearchProfile" ADD CONSTRAINT "SearchProfile_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "CandidateProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceConnector" ADD CONSTRAINT "SourceConnector_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrawlRun" ADD CONSTRAINT "CrawlRun_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "SourceConnector"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Office" ADD CONSTRAINT "Office_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyEvidence" ADD CONSTRAINT "CompanyEvidence_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_officeId_fkey" FOREIGN KEY ("officeId") REFERENCES "Office"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobListing" ADD CONSTRAINT "JobListing_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobListing" ADD CONSTRAINT "JobListing_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "SourceConnector"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobSnapshot" ADD CONSTRAINT "JobSnapshot_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "JobListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_searchProfileId_fkey" FOREIGN KEY ("searchProfileId") REFERENCES "SearchProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactPoint" ADD CONSTRAINT "ContactPoint_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailAccount" ADD CONSTRAINT "MailAccount_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "CandidateProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentVersion" ADD CONSTRAINT "DocumentVersion_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "CandidateProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DraftRevision" ADD CONSTRAINT "DraftRevision_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "ApplicationDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationPolicyVersion" ADD CONSTRAINT "AutomationPolicyVersion_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "AutomationPolicy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramLink" ADD CONSTRAINT "TelegramLink_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
