-- AlterTable
ALTER TABLE "auth_users" ADD COLUMN IF NOT EXISTS "suspendedUntil" TIMESTAMPTZ(3);
