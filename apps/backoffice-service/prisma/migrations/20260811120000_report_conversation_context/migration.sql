-- Additive only. Carries the conversation a report was filed from so a moderator
-- can tell WHERE the reported user/message lives: private room id, group room id,
-- or community id, plus which of the three. Null on every pre-existing row.
ALTER TABLE "Report" ADD COLUMN "roomId" TEXT;
ALTER TABLE "Report" ADD COLUMN "roomType" TEXT;
CREATE INDEX "Report_roomType_roomId_idx" ON "Report"("roomType", "roomId");
