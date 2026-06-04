-- Opaque refresh-token rework for AdminSession.
-- All existing sessions are invalidated by this change (the token model changes
-- entirely), so existing rows are cleared to allow adding the new required
-- columns without a default.
DELETE FROM "AdminSession";

-- DropIndex
DROP INDEX "AdminSession_jti_key";

-- AlterTable
ALTER TABLE "AdminSession" DROP COLUMN "expiresAt",
DROP COLUMN "jti",
ADD COLUMN     "refreshExpiresAt" TIMESTAMPTZ(3) NOT NULL,
ADD COLUMN     "refreshTokenHash" TEXT NOT NULL,
ADD COLUMN     "rotatedToId" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "AdminSession_refreshTokenHash_key" ON "AdminSession"("refreshTokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "AdminSession_rotatedToId_key" ON "AdminSession"("rotatedToId");
