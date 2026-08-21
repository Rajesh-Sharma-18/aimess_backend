-- AlterEnum
ALTER TYPE "AnnouncementStatus" ADD VALUE 'CANCELLED';

-- CreateEnum
CREATE TYPE "AnnouncementDeviceType" AS ENUM ('ALL', 'ANDROID', 'IOS', 'WEB');

-- AlterTable
ALTER TABLE "Announcement" ADD COLUMN "deviceType" "AnnouncementDeviceType" NOT NULL DEFAULT 'ALL',
ADD COLUMN "cancelledAt" TIMESTAMPTZ(3);
