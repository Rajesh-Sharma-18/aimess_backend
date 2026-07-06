-- Announcement schema redesign: flattens the model from the old i18n
-- (AnnouncementTranslation per-locale) shape to a single-locale
-- title/description shape with scheduling + delivery-tracking fields.
-- schema.prisma was updated for this redesign without a corresponding
-- migration ever being generated/applied — this migration closes that gap.
-- Scoped to Announcement only; does not touch UserIndex/UserWarning.

-- CreateEnum
CREATE TYPE "AnnouncementTarget" AS ENUM ('ALL', 'COMMUNITY');

-- CreateEnum
CREATE TYPE "AnnouncementStatus" AS ENUM ('SCHEDULED', 'PROCESSING', 'SENT', 'FAILED');

-- DropForeignKey
ALTER TABLE "AnnouncementTranslation" DROP CONSTRAINT "AnnouncementTranslation_announcementId_fkey";

-- AlterTable
ALTER TABLE "Announcement"
  ADD COLUMN     "title" TEXT,
  ADD COLUMN     "description" TEXT,
  ADD COLUMN     "communityId" UUID,
  ADD COLUMN     "scheduledAt" TIMESTAMPTZ(3),
  ADD COLUMN     "recipientCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN     "failureReason" TEXT,
  ADD COLUMN     "sentAt" TIMESTAMPTZ(3);

-- Backfill existing rows so the columns can be made NOT NULL without data loss.
UPDATE "Announcement" SET "title" = 'Untitled' WHERE "title" IS NULL;
UPDATE "Announcement" SET "description" = '' WHERE "description" IS NULL;

-- AlterTable (enforce NOT NULL now that existing rows are backfilled)
ALTER TABLE "Announcement"
  ALTER COLUMN "title" SET NOT NULL,
  ALTER COLUMN "description" SET NOT NULL;

-- AlterTable (target: derive from the old "audience" TEXT column, default 'all' -> ALL)
ALTER TABLE "Announcement" ADD COLUMN "target" "AnnouncementTarget";
UPDATE "Announcement" SET "target" = CASE
  WHEN "audience" = 'community' THEN 'COMMUNITY'::"AnnouncementTarget"
  ELSE 'ALL'::"AnnouncementTarget"
END;
ALTER TABLE "Announcement" ALTER COLUMN "target" SET NOT NULL;
ALTER TABLE "Announcement" DROP COLUMN "audience";
ALTER TABLE "Announcement" DROP COLUMN "publishAt";

-- AlterTable (status: TEXT default 'draft' -> AnnouncementStatus enum default SCHEDULED)
ALTER TABLE "Announcement" ADD COLUMN "status_new" "AnnouncementStatus";
UPDATE "Announcement" SET "status_new" = CASE
  WHEN "status" = 'sent' THEN 'SENT'::"AnnouncementStatus"
  WHEN "status" = 'failed' THEN 'FAILED'::"AnnouncementStatus"
  WHEN "status" = 'processing' THEN 'PROCESSING'::"AnnouncementStatus"
  ELSE 'SCHEDULED'::"AnnouncementStatus"
END;
ALTER TABLE "Announcement" DROP COLUMN "status";
ALTER TABLE "Announcement" RENAME COLUMN "status_new" TO "status";
ALTER TABLE "Announcement" ALTER COLUMN "status" SET NOT NULL;
ALTER TABLE "Announcement" ALTER COLUMN "status" SET DEFAULT 'SCHEDULED';

-- AlterTable (updatedAt: new required column, default now() for existing rows)
ALTER TABLE "Announcement" ADD COLUMN "updatedAt" TIMESTAMPTZ(3);
UPDATE "Announcement" SET "updatedAt" = "createdAt" WHERE "updatedAt" IS NULL;
ALTER TABLE "Announcement" ALTER COLUMN "updatedAt" SET NOT NULL;

-- DropTable
DROP TABLE "AnnouncementTranslation";

-- CreateIndex
CREATE INDEX "Announcement_status_scheduledAt_idx" ON "Announcement"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "Announcement_target_status_idx" ON "Announcement"("target", "status");

-- CreateIndex
CREATE INDEX "Announcement_createdAt_idx" ON "Announcement"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "Announcement_communityId_idx" ON "Announcement"("communityId");
