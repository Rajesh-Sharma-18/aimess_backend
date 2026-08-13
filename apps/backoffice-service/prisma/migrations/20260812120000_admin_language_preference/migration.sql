-- AlterTable
-- Additive only. Preferred admin-panel UI language ("en" | "th" | "vi").
-- Nullable with no default: every existing row stays NULL = "never chosen",
-- and the client keeps using its own stored/browser locale until the admin picks one.
ALTER TABLE "AdminUser" ADD COLUMN "language" TEXT;
