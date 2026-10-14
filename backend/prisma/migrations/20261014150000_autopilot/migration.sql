-- CreateTable
CREATE TABLE "AutopilotAction" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "inboundMessageId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "step" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'proposed',
    "mode" TEXT NOT NULL DEFAULT 'auto',
    "plan" JSONB NOT NULL DEFAULT '{}',
    "toEmail" TEXT,
    "detail" TEXT NOT NULL,
    "resultAttemptId" TEXT,
    "aiTasks" INTEGER NOT NULL DEFAULT 0,
    "decidedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "executedAt" TIMESTAMP(3),

    CONSTRAINT "AutopilotAction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AutopilotAction_inboundMessageId_key" ON "AutopilotAction"("inboundMessageId");

-- CreateIndex
CREATE INDEX "AutopilotAction_workspaceId_createdAt_idx" ON "AutopilotAction"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "AutopilotAction_workspaceId_state_idx" ON "AutopilotAction"("workspaceId", "state");

-- CreateIndex
CREATE INDEX "AutopilotAction_attemptId_idx" ON "AutopilotAction"("attemptId");

