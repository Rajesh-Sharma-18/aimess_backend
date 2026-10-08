-- whoCanViewProfile is retired: profile content is visible to everyone, subject to block/ban.
ALTER TABLE "privacy_settings" DROP COLUMN "whoCanViewProfile";
