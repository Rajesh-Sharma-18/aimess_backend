-- AlterTable
-- Nullable, no default: existing admin rows stay valid (avatarUrl = NULL) and a
-- system-generated default avatar is resolved on read when this is null.
ALTER TABLE "AdminUser" ADD COLUMN "avatarUrl" TEXT;
