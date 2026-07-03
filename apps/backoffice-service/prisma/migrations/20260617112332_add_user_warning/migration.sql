-- AlterTable
ALTER TABLE "UserIndex" ADD COLUMN     "warningCount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "UserWarning" (
    "id" UUID NOT NULL,
    "targetUserId" TEXT NOT NULL,
    "moderatorId" UUID NOT NULL,
    "warningReason" TEXT NOT NULL,
    "moderatorNotes" TEXT NOT NULL,
    "warningCategory" TEXT NOT NULL,
    "evidenceLinks" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reportId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserWarning_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserWarning_targetUserId_createdAt_idx" ON "UserWarning"("targetUserId", "createdAt" DESC);
