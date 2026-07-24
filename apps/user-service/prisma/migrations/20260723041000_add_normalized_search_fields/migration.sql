-- AlterTable
ALTER TABLE "user_profiles" ADD COLUMN     "normalizedFirstName" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "normalizedLastName" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "normalizedUsername" TEXT NOT NULL DEFAULT '';

-- CreateIndex
CREATE INDEX "user_profiles_normalizedUsername_idx" ON "user_profiles"("normalizedUsername");

-- CreateIndex
CREATE INDEX "user_profiles_normalizedFirstName_idx" ON "user_profiles"("normalizedFirstName");

-- CreateIndex
CREATE INDEX "user_profiles_normalizedLastName_idx" ON "user_profiles"("normalizedLastName");
