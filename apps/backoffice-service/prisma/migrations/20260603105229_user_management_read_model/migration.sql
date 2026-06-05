-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'BANNED', 'DELETED');

-- AlterTable
ALTER TABLE "ModerationAction" ADD COLUMN     "expiresAt" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "UserIndex" (
    "userId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "reportCount" INTEGER NOT NULL DEFAULT 0,
    "joinedAt" TIMESTAMPTZ(3) NOT NULL,
    "lastActiveAt" TIMESTAMPTZ(3),
    "bannedAt" TIMESTAMPTZ(3),
    "banReason" TEXT,
    "suspendedUntil" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "UserIndex_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE INDEX "UserIndex_status_joinedAt_idx" ON "UserIndex"("status", "joinedAt" DESC);

-- CreateIndex
CREATE INDEX "UserIndex_reportCount_idx" ON "UserIndex"("reportCount");

-- CreateIndex
CREATE INDEX "UserIndex_username_idx" ON "UserIndex"("username");

-- CreateIndex
CREATE INDEX "UserIndex_email_idx" ON "UserIndex"("email");

-- CreateIndex
CREATE INDEX "ModerationAction_targetType_targetId_createdAt_idx" ON "ModerationAction"("targetType", "targetId", "createdAt" DESC);
