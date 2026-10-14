ALTER TABLE "MailAccount" ALTER COLUMN "dailyLimit" SET DEFAULT 300;
UPDATE "MailAccount" SET "dailyLimit" = 300 WHERE "dailyLimit" = 20;
