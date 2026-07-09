-- CreateEnum
CREATE TYPE "RecentSearchTargetType" AS ENUM ('USER', 'GROUP');

-- CreateTable
CREATE TABLE "recent_user_searches" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "targetType" "RecentSearchTargetType" NOT NULL,
    "targetId" VARCHAR(64) NOT NULL,
    "lastViewedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recent_user_searches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "recent_user_searches_userId_lastViewedAt_idx" ON "recent_user_searches"("userId", "lastViewedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "recent_user_searches_userId_targetType_targetId_key" ON "recent_user_searches"("userId", "targetType", "targetId");

-- AddForeignKey
ALTER TABLE "recent_user_searches" ADD CONSTRAINT "recent_user_searches_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user_profiles"("userId") ON DELETE CASCADE ON UPDATE CASCADE;
