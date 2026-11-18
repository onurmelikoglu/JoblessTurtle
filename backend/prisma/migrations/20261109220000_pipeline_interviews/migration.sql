-- Başvuru aşamaları ve mülâkatlar
-- CreateTable
CREATE TABLE "ApplicationStage" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApplicationStage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Interview" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "durationMin" INTEGER NOT NULL DEFAULT 60,
    "kind" TEXT NOT NULL DEFAULT 'video',
    "link" TEXT,
    "location" TEXT,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "source" TEXT NOT NULL DEFAULT 'manual',
    "inboundMessageId" TEXT,
    "remindedDayAt" TIMESTAMP(3),
    "remindedHourAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Interview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ApplicationStage_attemptId_idx" ON "ApplicationStage"("attemptId");

-- CreateIndex
CREATE INDEX "Interview_workspaceId_startsAt_idx" ON "Interview"("workspaceId", "startsAt");

-- CreateIndex
CREATE INDEX "Interview_attemptId_idx" ON "Interview"("attemptId");

