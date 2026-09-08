-- EVERYONE is retired as a selectable call scope: it was the only scope that let a
-- non-friend ring a user. Existing rows fall back to FRIENDS and the column default
-- follows. The enum value itself is kept so historical rows/replicas stay readable.
ALTER TABLE "privacy_settings" ALTER COLUMN "whoCanCallMe" SET DEFAULT 'FRIENDS';

UPDATE "privacy_settings" SET "whoCanCallMe" = 'FRIENDS' WHERE "whoCanCallMe" = 'EVERYONE';
