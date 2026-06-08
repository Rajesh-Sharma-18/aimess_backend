-- AlterTable
ALTER TABLE "Report" ADD COLUMN     "details" TEXT;

-- CreateIndex
CREATE INDEX "Report_type_targetId_createdAt_idx" ON "Report"("type", "targetId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Report_reporterId_idx" ON "Report"("reporterId");
