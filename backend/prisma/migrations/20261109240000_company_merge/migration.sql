-- Aynı firmanın birleştirilen kaydı: kalan kayda yönlendirme
-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "mergedIntoId" TEXT;

-- CreateIndex
CREATE INDEX "Company_mergedIntoId_idx" ON "Company"("mergedIntoId");

