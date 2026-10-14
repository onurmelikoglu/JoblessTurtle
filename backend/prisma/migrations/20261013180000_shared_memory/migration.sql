-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "catalogId" TEXT,
ADD COLUMN     "employeeCount" INTEGER,
ADD COLUMN     "employeeRange" TEXT,
ADD COLUMN     "linkedinUrl" TEXT;

-- CreateTable
CREATE TABLE "CatalogCompany" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "canonicalDomain" TEXT,
    "website" TEXT,
    "careersUrl" TEXT,
    "linkedinUrl" TEXT,
    "groupName" TEXT,
    "sectors" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "services" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "summary" TEXT,
    "employeeRange" TEXT,
    "employeeCount" INTEGER,
    "employeeSource" TEXT,
    "employeeCheckedAt" TIMESTAMP(3),
    "cities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "offices" JSONB NOT NULL DEFAULT '[]',
    "sources" JSONB NOT NULL DEFAULT '[]',
    "contacts" JSONB NOT NULL DEFAULT '[]',
    "jobs" JSONB NOT NULL DEFAULT '[]',
    "discoveredFor" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "researchedAt" TIMESTAMP(3),
    "contactsSearchedAt" TIMESTAMP(3),
    "officesSearchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogCompany_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AddressRecord" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "sourceType" TEXT NOT NULL DEFAULT 'unknown',
    "foundBy" TEXT,
    "sent" INTEGER NOT NULL DEFAULT 0,
    "delivered" INTEGER NOT NULL DEFAULT 0,
    "bounced" INTEGER NOT NULL DEFAULT 0,
    "replied" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'unknown',
    "deadReason" TEXT,
    "deadAt" TIMESTAMP(3),
    "lastSentAt" TIMESTAMP(3),
    "lastOutcomeAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AddressRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeadDomain" (
    "domain" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "deadAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeadDomain_pkey" PRIMARY KEY ("domain")
);

-- CreateTable
CREATE TABLE "LearningEvent" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "companyId" TEXT,
    "catalogCompanyId" TEXT,
    "attemptId" TEXT,
    "aiTaskId" TEXT,
    "features" JSONB NOT NULL DEFAULT '{}',
    "outcome" JSONB,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LearningEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CatalogCompany_key_key" ON "CatalogCompany"("key");

-- CreateIndex
CREATE INDEX "CatalogCompany_normalizedName_idx" ON "CatalogCompany"("normalizedName");

-- CreateIndex
CREATE INDEX "CatalogCompany_canonicalDomain_idx" ON "CatalogCompany"("canonicalDomain");

-- CreateIndex
CREATE UNIQUE INDEX "AddressRecord_email_key" ON "AddressRecord"("email");

-- CreateIndex
CREATE INDEX "AddressRecord_domain_idx" ON "AddressRecord"("domain");

-- CreateIndex
CREATE INDEX "AddressRecord_status_idx" ON "AddressRecord"("status");

-- CreateIndex
CREATE INDEX "LearningEvent_kind_createdAt_idx" ON "LearningEvent"("kind", "createdAt");

-- CreateIndex
CREATE INDEX "LearningEvent_workspaceId_kind_idx" ON "LearningEvent"("workspaceId", "kind");

-- CreateIndex
CREATE INDEX "LearningEvent_kind_resolvedAt_idx" ON "LearningEvent"("kind", "resolvedAt");

-- CreateIndex
CREATE UNIQUE INDEX "LearningEvent_kind_attemptId_key" ON "LearningEvent"("kind", "attemptId");

-- CreateIndex
CREATE INDEX "Company_catalogId_idx" ON "Company"("catalogId");

