-- AlterTable
-- Reuses the existing "AuthProvider" enum (EMAIL | APPLE | GOOGLE). Nullable
-- with no default, so existing and new rows start as NULL until the user links
-- their first sign-in method.
ALTER TABLE "auth_users" ADD COLUMN "primaryAccount" "AuthProvider";
