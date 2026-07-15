-- Additive only. Carries the reported USER when the report's target isn't a user
-- (message sender for `message` reports; comment author for `stream` reports).
-- Null for user/community reports and pre-existing rows.
ALTER TABLE "Report" ADD COLUMN "reportedUserId" UUID;
CREATE INDEX "Report_reportedUserId_idx" ON "Report"("reportedUserId");
