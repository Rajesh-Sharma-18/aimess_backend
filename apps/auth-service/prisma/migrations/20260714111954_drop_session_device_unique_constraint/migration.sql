-- DropIndex
DROP INDEX "sessions_userId_deviceId_key";

-- CreateIndex
CREATE INDEX "sessions_userId_deviceId_idx" ON "sessions"("userId", "deviceId");
