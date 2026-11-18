-- Firma: telefon ve genel çalışma düzeni
ALTER TABLE "Company" ADD COLUMN "phone" TEXT;
ALTER TABLE "Company" ADD COLUMN "workPolicy" TEXT;

-- Toplu firma araştırması: kalıcı iş ve firma başına ilerleme
CREATE TABLE "ResearchBatch" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "createdById" TEXT,
    "origin" TEXT NOT NULL DEFAULT 'user',
    "force" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'running',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "ResearchBatch_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ResearchBatchItem" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'queued',
    "found" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "note" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "context" JSONB NOT NULL DEFAULT '{}',
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResearchBatchItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ResearchBatch_workspaceId_status_idx" ON "ResearchBatch"("workspaceId", "status");
CREATE UNIQUE INDEX "ResearchBatchItem_batchId_companyId_key" ON "ResearchBatchItem"("batchId", "companyId");
CREATE INDEX "ResearchBatchItem_state_idx" ON "ResearchBatchItem"("state");
CREATE INDEX "ResearchBatchItem_companyId_idx" ON "ResearchBatchItem"("companyId");

ALTER TABLE "ResearchBatchItem" ADD CONSTRAINT "ResearchBatchItem_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "ResearchBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
