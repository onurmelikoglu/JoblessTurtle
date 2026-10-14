-- AlterTable
ALTER TABLE "SearchProfile" ADD COLUMN     "abroadRegions" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "abroadRelocation" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "abroadRemote" BOOLEAN NOT NULL DEFAULT false;

