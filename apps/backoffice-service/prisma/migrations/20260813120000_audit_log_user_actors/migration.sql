-- CreateEnum
CREATE TYPE "AuditActorType" AS ENUM ('ADMIN', 'USER', 'SYSTEM');

-- DropForeignKey
-- End-user ids live in auth_db, not admin_db: the FK to AdminUser would reject every
-- website-side audit row, so the actor is resolved in application code instead.
ALTER TABLE "AuditLog" DROP CONSTRAINT "AuditLog_actorId_fkey";

-- AlterTable
ALTER TABLE "AuditLog" ALTER COLUMN "actorId" DROP NOT NULL;
ALTER TABLE "AuditLog" ADD COLUMN "actorType" "AuditActorType" NOT NULL DEFAULT 'ADMIN';
ALTER TABLE "AuditLog" ADD COLUMN "eventId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "AuditLog_eventId_key" ON "AuditLog"("eventId");

-- CreateIndex
CREATE INDEX "AuditLog_actorType_createdAt_idx" ON "AuditLog"("actorType", "createdAt");
