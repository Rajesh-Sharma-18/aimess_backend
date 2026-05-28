-- AlterTable
ALTER TABLE "auth_users" ADD COLUMN     "fcmTokens" TEXT[] DEFAULT ARRAY[]::TEXT[];
