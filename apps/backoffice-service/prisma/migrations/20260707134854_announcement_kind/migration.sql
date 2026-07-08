-- CreateEnum
CREATE TYPE "AnnouncementKind" AS ENUM ('ANNOUNCEMENT', 'MAINTENANCE', 'UPDATE_REQUIRED');

-- AlterTable
ALTER TABLE "Announcement" ADD COLUMN "kind" "AnnouncementKind" NOT NULL DEFAULT 'ANNOUNCEMENT';
