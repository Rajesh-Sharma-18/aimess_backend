-- CreateEnum
CREATE TYPE "AuditSource" AS ENUM ('ADMIN_PANEL', 'WEB', 'ANDROID', 'IOS', 'SYSTEM');

-- AlterTable
-- SYSTEM is the safe default: a row written by a job/consumer had no client, and a
-- publisher that predates this column says nothing about where it came from.
ALTER TABLE "AuditLog" ADD COLUMN "source" "AuditSource" NOT NULL DEFAULT 'SYSTEM';

-- Backfill the rows that already exist. Every ADMIN-actor row was, by construction,
-- written by an admin-panel request handler; every end-user row predates any client
-- signal, and the website was the only client publishing activity at the time.
UPDATE "AuditLog" SET "source" = 'ADMIN_PANEL' WHERE "actorType" = 'ADMIN';
UPDATE "AuditLog" SET "source" = 'WEB' WHERE "actorType" = 'USER';

-- CreateIndex
CREATE INDEX "AuditLog_source_createdAt_idx" ON "AuditLog"("source", "createdAt");
