-- Orijinal CV'nin tasarım şablonu: iyileştirilmiş CV aynı görünümle PDF'e çevrilir.
ALTER TABLE "DocumentVersion" ADD COLUMN "layout" JSONB;
