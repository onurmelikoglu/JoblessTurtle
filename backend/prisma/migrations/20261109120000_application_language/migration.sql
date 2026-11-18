-- Başvuru dili: firma için elle seçilen dil (null = otomatik) ve taslağın dili
ALTER TABLE "Company" ADD COLUMN "applicationLanguage" TEXT;
ALTER TABLE "ApplicationDraft" ADD COLUMN "language" TEXT NOT NULL DEFAULT 'tr';
