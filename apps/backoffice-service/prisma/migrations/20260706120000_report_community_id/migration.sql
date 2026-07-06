-- Additive only. Carries the community a report was filed in (community-service
-- member/community reports only); null for community-less reports (e.g.
-- chat-service private-message reports) and for pre-existing rows.
ALTER TABLE "Report" ADD COLUMN "communityId" TEXT;
