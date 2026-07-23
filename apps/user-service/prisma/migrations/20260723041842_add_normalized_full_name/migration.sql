-- AlterTable
ALTER TABLE "user_profiles" ADD COLUMN     "normalizedFullName" TEXT NOT NULL DEFAULT '';

-- CreateIndex
CREATE INDEX "user_profiles_normalizedFullName_idx" ON "user_profiles"("normalizedFullName");
