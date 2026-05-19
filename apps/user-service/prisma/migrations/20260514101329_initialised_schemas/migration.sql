-- CreateEnum
CREATE TYPE "ProfileStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DELETED');

-- CreateEnum
CREATE TYPE "FriendshipStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED', 'UNFRIENDED');

-- CreateEnum
CREATE TYPE "PrivacyScope" AS ENUM ('EVERYONE', 'FRIENDS_OF_FRIENDS', 'FRIENDS', 'NO_ONE');

-- CreateEnum
CREATE TYPE "CallPrivacyScope" AS ENUM ('FRIENDS', 'SELECTED_FRIENDS', 'NO_ONE');

-- CreateEnum
CREATE TYPE "AutoDeleteTimer" AS ENUM ('OFF', 'HOURS_24', 'WEEK_1', 'MONTH_1');

-- CreateEnum
CREATE TYPE "AppTheme" AS ENUM ('LIGHT', 'DARK', 'AUTO');

-- CreateEnum
CREATE TYPE "AutoplayMode" AS ENUM ('ALWAYS', 'WIFI_ONLY', 'NEVER');

-- CreateTable
CREATE TABLE "user_profiles" (
    "userId" UUID NOT NULL,
    "username" TEXT NOT NULL,
    "firstName" VARCHAR(50) NOT NULL,
    "lastName" VARCHAR(50) NOT NULL,
    "bio" VARCHAR(280),
    "avatarUrl" TEXT,
    "coverImageUrl" TEXT,
    "dateOfBirth" DATE NOT NULL,
    "lastUsernameChangeAt" TIMESTAMP(3),
    "friendsCount" INTEGER NOT NULL DEFAULT 0,
    "communitiesCount" INTEGER NOT NULL DEFAULT 0,
    "groupsCount" INTEGER NOT NULL DEFAULT 0,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "lastSeenAt" TIMESTAMP(3),
    "status" "ProfileStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "user_profiles_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "friendships" (
    "id" UUID NOT NULL,
    "requesterId" UUID NOT NULL,
    "addresseeId" UUID NOT NULL,
    "status" "FriendshipStatus" NOT NULL DEFAULT 'PENDING',
    "acceptedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "unfriendedAt" TIMESTAMP(3),
    "unfriendedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "friendships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blocks" (
    "id" UUID NOT NULL,
    "blockerId" UUID NOT NULL,
    "blockedId" UUID NOT NULL,
    "reason" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "privacy_settings" (
    "userId" UUID NOT NULL,
    "whoCanFindMe" "PrivacyScope" NOT NULL DEFAULT 'EVERYONE',
    "whoCanSendFriendRequests" "PrivacyScope" NOT NULL DEFAULT 'EVERYONE',
    "whoCanSeeOnlineStatus" "PrivacyScope" NOT NULL DEFAULT 'FRIENDS',
    "whoCanViewProfile" "PrivacyScope" NOT NULL DEFAULT 'EVERYONE',
    "whoCanCallMe" "CallPrivacyScope" NOT NULL DEFAULT 'FRIENDS',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "privacy_settings_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "call_allowed_friends" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "allowedUserId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "call_allowed_friends_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_settings" (
    "userId" UUID NOT NULL,
    "autoDeleteTimer" "AutoDeleteTimer" NOT NULL DEFAULT 'OFF',
    "typingIndicators" BOOLEAN NOT NULL DEFAULT true,
    "readReceipts" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_settings_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "app_settings" (
    "userId" UUID NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'vi',
    "theme" "AppTheme" NOT NULL DEFAULT 'AUTO',
    "dataSaverMode" BOOLEAN NOT NULL DEFAULT false,
    "autoplayVideos" "AutoplayMode" NOT NULL DEFAULT 'WIFI_ONLY',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "recent_searches" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "searchedUserId" UUID,
    "query" VARCHAR(100),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recent_searches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_profiles_username_key" ON "user_profiles"("username");

-- CreateIndex
CREATE INDEX "user_profiles_username_idx" ON "user_profiles"("username");

-- CreateIndex
CREATE INDEX "user_profiles_firstName_lastName_idx" ON "user_profiles"("firstName", "lastName");

-- CreateIndex
CREATE INDEX "user_profiles_status_deletedAt_idx" ON "user_profiles"("status", "deletedAt");

-- CreateIndex
CREATE INDEX "friendships_addresseeId_status_idx" ON "friendships"("addresseeId", "status");

-- CreateIndex
CREATE INDEX "friendships_requesterId_status_idx" ON "friendships"("requesterId", "status");

-- CreateIndex
CREATE INDEX "friendships_status_acceptedAt_idx" ON "friendships"("status", "acceptedAt");

-- CreateIndex
CREATE UNIQUE INDEX "friendships_requesterId_addresseeId_key" ON "friendships"("requesterId", "addresseeId");

-- CreateIndex
CREATE INDEX "blocks_blockedId_idx" ON "blocks"("blockedId");

-- CreateIndex
CREATE UNIQUE INDEX "blocks_blockerId_blockedId_key" ON "blocks"("blockerId", "blockedId");

-- CreateIndex
CREATE INDEX "call_allowed_friends_ownerId_idx" ON "call_allowed_friends"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "call_allowed_friends_ownerId_allowedUserId_key" ON "call_allowed_friends"("ownerId", "allowedUserId");

-- CreateIndex
CREATE INDEX "recent_searches_userId_createdAt_idx" ON "recent_searches"("userId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "user_profiles"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_addresseeId_fkey" FOREIGN KEY ("addresseeId") REFERENCES "user_profiles"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_blockerId_fkey" FOREIGN KEY ("blockerId") REFERENCES "user_profiles"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_blockedId_fkey" FOREIGN KEY ("blockedId") REFERENCES "user_profiles"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "privacy_settings" ADD CONSTRAINT "privacy_settings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user_profiles"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_allowed_friends" ADD CONSTRAINT "call_allowed_friends_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user_profiles"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_settings" ADD CONSTRAINT "chat_settings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user_profiles"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user_profiles"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recent_searches" ADD CONSTRAINT "recent_searches_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user_profiles"("userId") ON DELETE CASCADE ON UPDATE CASCADE;
