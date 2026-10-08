-- whoCanCallMe = EVERYONE is retired; calls are friends-only.
UPDATE "privacy_settings" SET "whoCanCallMe" = 'FRIENDS' WHERE "whoCanCallMe" = 'EVERYONE';
