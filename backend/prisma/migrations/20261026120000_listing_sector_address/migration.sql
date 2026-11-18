-- AlterTable
ALTER TABLE "ScrapedJob" ADD COLUMN "companySector" TEXT,
ADD COLUMN "address" TEXT;

-- AlterTable
ALTER TABLE "Job" ADD COLUMN "address" TEXT;
