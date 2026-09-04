-- AlterTable
ALTER TABLE "auth_users" ADD COLUMN IF NOT EXISTS "purgedAt" TIMESTAMPTZ(3);
