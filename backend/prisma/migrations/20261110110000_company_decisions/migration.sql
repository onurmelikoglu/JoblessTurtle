-- Benzer adlı firma kararı: yeni firma açılmadan önce ilanlar kullanıcının kararına kadar bekletilir.
CREATE TABLE "CompanyDecision" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "domain" TEXT,
    "suggestedCompanyId" TEXT NOT NULL,
    "reasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "payload" JSONB NOT NULL,
    "listingCount" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "CompanyDecision_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CompanyDecision_workspaceId_normalizedName_suggestedCompany_key" ON "CompanyDecision"("workspaceId", "normalizedName", "suggestedCompanyId");
CREATE INDEX "CompanyDecision_workspaceId_status_idx" ON "CompanyDecision"("workspaceId", "status");
