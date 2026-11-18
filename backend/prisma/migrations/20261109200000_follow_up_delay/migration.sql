-- Takip taslağının kaç iş günü sonra hazırlanacağı (otomatik başvuru ayarı)
ALTER TABLE "AutomationPolicy" ADD COLUMN "followUpDelayDays" INTEGER NOT NULL DEFAULT 7;
