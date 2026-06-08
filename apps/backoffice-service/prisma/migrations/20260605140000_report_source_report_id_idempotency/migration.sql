-- AlterTable
ALTER TABLE "Report" ADD COLUMN     "sourceReportId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Report_sourceReportId_key" ON "Report"("sourceReportId");
