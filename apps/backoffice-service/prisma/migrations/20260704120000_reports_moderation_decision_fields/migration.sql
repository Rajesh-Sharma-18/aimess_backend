-- Additive only. Backfills `updatedAt` from `createdAt` for existing rows so
-- the NOT NULL constraint can be added without data loss.
ALTER TABLE "Report" ADD COLUMN "updatedAt" TIMESTAMPTZ(3);
UPDATE "Report" SET "updatedAt" = "createdAt" WHERE "updatedAt" IS NULL;
ALTER TABLE "Report" ALTER COLUMN "updatedAt" SET NOT NULL;

ALTER TABLE "Report" ADD COLUMN "resolution" TEXT;
ALTER TABLE "Report" ADD COLUMN "dismissReason" TEXT;
ALTER TABLE "Report" ADD COLUMN "decisionNote" TEXT;
ALTER TABLE "Report" ADD COLUMN "resolvedAt" TIMESTAMPTZ(3);

CREATE INDEX "ModerationAction_reportId_createdAt_idx" ON "ModerationAction"("reportId", "createdAt" DESC);
