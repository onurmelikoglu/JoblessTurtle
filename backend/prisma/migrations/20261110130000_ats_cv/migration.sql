-- ATS uyumu: CV sürümleri (orijinal, ana ATS, ilana özel), yapısal CV içeriği, ilan gereksinimleri ve oran önbelleği.
ALTER TABLE "DocumentVersion" ADD COLUMN "variant" TEXT NOT NULL DEFAULT 'original';
ALTER TABLE "DocumentVersion" ADD COLUMN "parentId" TEXT;
ALTER TABLE "DocumentVersion" ADD COLUMN "targetJobId" TEXT;
ALTER TABLE "DocumentVersion" ADD COLUMN "content" JSONB;
ALTER TABLE "DocumentVersion" ADD COLUMN "addedSkills" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "DocumentVersion" ADD COLUMN "pendingPromotion" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "DocumentVersion_candidateId_variant_idx" ON "DocumentVersion"("candidateId", "variant");

ALTER TABLE "Job" ADD COLUMN "atsProfile" JSONB;
ALTER TABLE "Job" ADD COLUMN "atsProfileAt" TIMESTAMP(3);

CREATE TABLE "AtsScore" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "breakdown" JSONB NOT NULL,
    "missing" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AtsScore_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AtsScore_documentId_jobId_key" ON "AtsScore"("documentId", "jobId");
CREATE INDEX "AtsScore_jobId_idx" ON "AtsScore"("jobId");
