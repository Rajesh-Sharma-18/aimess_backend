/*
  Warnings:

  - You are about to drop the column `audience` on the `Announcement` table. All the data in the column will be lost.
  - You are about to drop the column `publishAt` on the `Announcement` table. All the data in the column will be lost.
  - The `status` column on the `Announcement` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - You are about to drop the `AnnouncementTranslation` table. If the table is not empty, all the data it contains will be lost.
  - Added the required column `description` to the `Announcement` table without a default value. This is not possible if the table is not empty.
  - Added the required column `target` to the `Announcement` table without a default value. This is not possible if the table is not empty.
  - Added the required column `title` to the `Announcement` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `Announcement` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "AnnouncementTarget" AS ENUM ('ALL', 'COMMUNITY');

-- CreateEnum
CREATE TYPE "AnnouncementStatus" AS ENUM ('SCHEDULED', 'PROCESSING', 'SENT', 'FAILED');

-- DropForeignKey
ALTER TABLE "AnnouncementTranslation" DROP CONSTRAINT "AnnouncementTranslation_announcementId_fkey";

-- AlterTable
ALTER TABLE "Announcement" DROP COLUMN "audience",
DROP COLUMN "publishAt",
ADD COLUMN     "communityId" UUID,
ADD COLUMN     "description" TEXT NOT NULL,
ADD COLUMN     "failureReason" TEXT,
ADD COLUMN     "recipientCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "scheduledAt" TIMESTAMPTZ(3),
ADD COLUMN     "sentAt" TIMESTAMPTZ(3),
ADD COLUMN     "target" "AnnouncementTarget" NOT NULL,
ADD COLUMN     "title" TEXT NOT NULL,
ADD COLUMN     "updatedAt" TIMESTAMPTZ(3) NOT NULL,
DROP COLUMN "status",
ADD COLUMN     "status" "AnnouncementStatus" NOT NULL DEFAULT 'SCHEDULED';

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
