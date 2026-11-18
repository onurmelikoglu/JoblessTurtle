-- Eksik yabancı anahtar indeksleri ve takip işinin yeniden deneme alanları
-- AlterTable
ALTER TABLE "FollowUp" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastError" TEXT;

-- CreateIndex
CREATE INDEX "ApplicationAttempt_companyId_idx" ON "ApplicationAttempt"("companyId");

-- CreateIndex
CREATE INDEX "ApplicationAttempt_retryOfId_idx" ON "ApplicationAttempt"("retryOfId");

-- CreateIndex
CREATE INDEX "ApplicationAttempt_state_sendingAt_idx" ON "ApplicationAttempt"("state", "sendingAt");

-- CreateIndex
CREATE INDEX "ApplicationDraft_opportunityId_idx" ON "ApplicationDraft"("opportunityId");

-- CreateIndex
CREATE INDEX "ApplicationDraft_followUpOfId_idx" ON "ApplicationDraft"("followUpOfId");

-- CreateIndex
CREATE INDEX "ContactPoint_workspaceId_email_idx" ON "ContactPoint"("workspaceId", "email");

-- CreateIndex
CREATE INDEX "FollowUp_state_dueAt_idx" ON "FollowUp"("state", "dueAt");

-- CreateIndex
CREATE INDEX "InboundMessage_resentAttemptId_idx" ON "InboundMessage"("resentAttemptId");

-- CreateIndex
CREATE INDEX "Job_companyId_idx" ON "Job"("companyId");

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_idx" ON "Notification"("userId", "readAt");

-- CreateIndex
CREATE INDEX "Office_companyId_idx" ON "Office"("companyId");

-- CreateIndex
CREATE INDEX "Opportunity_companyId_idx" ON "Opportunity"("companyId");

-- CreateIndex
CREATE INDEX "Opportunity_jobId_idx" ON "Opportunity"("jobId");

