-- CreateTable
CREATE TABLE "LivestreamIndex" (
    "streamId" TEXT NOT NULL,
    "communityId" TEXT NOT NULL,
    "communityName" TEXT NOT NULL DEFAULT '',
    "creatorId" TEXT NOT NULL,
    "creatorUsername" TEXT NOT NULL DEFAULT '',
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "thumbnailUrl" TEXT,
    "sourceType" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "hlsUrl" TEXT,
    "flvUrl" TEXT,
    "viewerCount" INTEGER NOT NULL DEFAULT 0,
    "peakViewers" INTEGER NOT NULL DEFAULT 0,
    "totalComments" INTEGER NOT NULL DEFAULT 0,
    "livedAt" TIMESTAMPTZ(3),
    "endedAt" TIMESTAMPTZ(3),
    "durationSeconds" INTEGER NOT NULL DEFAULT 0,
    "reasonCode" TEXT,
    "endedByAdminId" TEXT,
    "endedByAdminName" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "LivestreamIndex_pkey" PRIMARY KEY ("streamId")
);

-- CreateIndex
CREATE INDEX "LivestreamIndex_status_createdAt_idx" ON "LivestreamIndex"("status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "LivestreamIndex_communityId_status_idx" ON "LivestreamIndex"("communityId", "status");

-- CreateIndex
CREATE INDEX "LivestreamIndex_creatorId_idx" ON "LivestreamIndex"("creatorId");
