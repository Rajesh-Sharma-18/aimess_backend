-- Remap legacy AutoDeleteTimer values before swapping the enum. The old values
-- (HOURS_24, WEEK_1, MONTH_1) have no day-based equivalent in the new design, so
-- existing rows are reset to OFF (the default).
UPDATE "chat_settings" SET "autoDeleteTimer" = 'OFF' WHERE "autoDeleteTimer" <> 'OFF';

-- AlterEnum
BEGIN;
CREATE TYPE "AutoDeleteTimer_new" AS ENUM ('OFF', 'DAYS_7', 'DAYS_15', 'DAYS_30');
ALTER TABLE "chat_settings" ALTER COLUMN "autoDeleteTimer" DROP DEFAULT;
ALTER TABLE "chat_settings" ALTER COLUMN "autoDeleteTimer" TYPE "AutoDeleteTimer_new" USING ("autoDeleteTimer"::text::"AutoDeleteTimer_new");
ALTER TYPE "AutoDeleteTimer" RENAME TO "AutoDeleteTimer_old";
ALTER TYPE "AutoDeleteTimer_new" RENAME TO "AutoDeleteTimer";
DROP TYPE "AutoDeleteTimer_old";
ALTER TABLE "chat_settings" ALTER COLUMN "autoDeleteTimer" SET DEFAULT 'OFF';
COMMIT;

-- CreateEnum
CREATE TYPE "LiveStreamQuality" AS ENUM ('AUTO', 'HIGH_1080P', 'STANDARD_720P', 'DATA_SAVER_480P');

-- AlterTable: drop fields not in the design, align language default to English.
ALTER TABLE "app_settings" DROP COLUMN "autoplayVideos";
ALTER TABLE "app_settings" DROP COLUMN "dataSaverMode";
ALTER TABLE "app_settings" ALTER COLUMN "language" SET DEFAULT 'en';

-- DropEnum
DROP TYPE "AutoplayMode";

-- CreateTable
CREATE TABLE "notification_settings" (
    "userId" UUID NOT NULL,
    "chatEnabled" BOOLEAN NOT NULL DEFAULT true,
    "callEnabled" BOOLEAN NOT NULL DEFAULT true,
    "friendRequestEnabled" BOOLEAN NOT NULL DEFAULT true,
    "systemEnabled" BOOLEAN NOT NULL DEFAULT true,
    "communityEnabled" BOOLEAN NOT NULL DEFAULT true,
    "liveStreamEnabled" BOOLEAN NOT NULL DEFAULT true,
    "quietHoursEnabled" BOOLEAN NOT NULL DEFAULT false,
    "quietHoursStart" TEXT,
    "quietHoursEnd" TEXT,
    "quietHoursDays" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_settings_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "livestream_settings" (
    "userId" UUID NOT NULL,
    "defaultVideoQuality" "LiveStreamQuality" NOT NULL DEFAULT 'AUTO',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "livestream_settings_pkey" PRIMARY KEY ("userId")
);

-- AddForeignKey
ALTER TABLE "notification_settings" ADD CONSTRAINT "notification_settings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user_profiles"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "livestream_settings" ADD CONSTRAINT "livestream_settings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user_profiles"("userId") ON DELETE CASCADE ON UPDATE CASCADE;
