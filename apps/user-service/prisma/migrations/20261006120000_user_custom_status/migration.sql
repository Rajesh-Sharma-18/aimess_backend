-- AlterTable
ALTER TABLE "user_profiles" ADD COLUMN     "customStatusEmoji" VARCHAR(32),
ADD COLUMN     "customStatusExpiresAt" TIMESTAMPTZ(3),
ADD COLUMN     "customStatusStartedAt" TIMESTAMPTZ(3),
ADD COLUMN     "customStatusText" VARCHAR(200),
ADD COLUMN     "customStatusUpdatedAt" TIMESTAMPTZ(3);

-- CreateIndex
CREATE INDEX "user_profiles_customStatusExpiresAt_idx" ON "user_profiles"("customStatusExpiresAt");
