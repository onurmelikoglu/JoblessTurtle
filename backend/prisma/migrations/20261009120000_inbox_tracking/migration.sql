ALTER TABLE "MailAccount" ADD COLUMN "inboxSyncEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "MailAccount" ADD COLUMN "inboxSyncedAt" TIMESTAMP(3);
ALTER TABLE "MailAccount" ADD COLUMN "inboxError" TEXT;

ALTER TABLE "ApplicationAttempt" ADD COLUMN "retryOfId" TEXT;

ALTER TABLE "InboundMessage" ADD COLUMN "category" TEXT;
ALTER TABLE "InboundMessage" ADD COLUMN "reason" TEXT;
ALTER TABLE "InboundMessage" ADD COLUMN "bodyText" TEXT;
ALTER TABLE "InboundMessage" ADD COLUMN "failedRecipient" TEXT;
ALTER TABLE "InboundMessage" ADD COLUMN "suggestedEmail" TEXT;
ALTER TABLE "InboundMessage" ADD COLUMN "suggestedUrl" TEXT;
ALTER TABLE "InboundMessage" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'open';
ALTER TABLE "InboundMessage" ADD COLUMN "resentAttemptId" TEXT;
ALTER TABLE "InboundMessage" ADD COLUMN "handledAt" TIMESTAMP(3);

CREATE INDEX "InboundMessage_workspaceId_status_idx" ON "InboundMessage"("workspaceId", "status");
CREATE INDEX "InboundMessage_attemptId_idx" ON "InboundMessage"("attemptId");
