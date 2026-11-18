-- Otomatik başvuru ayarları: şehir, çalışma şekli ve çalışan sayısı filtreleri, arama aralığı, ATS iyileştirme.
-- Fırsatın son otomatik başvuru değerlendirmesinin engel kodları "neden başvurmadı" özetini besler.
ALTER TABLE "AutomationPolicy" ADD COLUMN "filterCities" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "AutomationPolicy" ADD COLUMN "filterWorkModes" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "AutomationPolicy" ADD COLUMN "filterSizes" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "AutomationPolicy" ADD COLUMN "includeUnknownWorkMode" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "AutomationPolicy" ADD COLUMN "includeUnknownSize" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "AutomationPolicy" ADD COLUMN "searchEveryHours" INTEGER NOT NULL DEFAULT 24;
ALTER TABLE "AutomationPolicy" ADD COLUMN "atsAutoImprove" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Opportunity" ADD COLUMN "autoReasons" JSONB;
ALTER TABLE "Opportunity" ADD COLUMN "autoEvaluatedAt" TIMESTAMP(3);
