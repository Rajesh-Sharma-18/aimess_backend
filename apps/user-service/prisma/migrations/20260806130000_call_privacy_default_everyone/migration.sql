-- "Who can call me" now defaults to EVERYONE.
--
-- The old default was FRIENDS, which is not one of the choices the Privacy
-- screen offers (Everyone / Selected Friends / No one), so every untouched
-- account rendered a blank value and could not be set back to it from the UI.
--
-- Default only: existing rows keep whatever they already hold. Rewriting a
-- stored FRIENDS to EVERYONE would let strangers ring users who never asked
-- for that, so it is a separate, explicit decision.
ALTER TABLE "privacy_settings"
  ALTER COLUMN "whoCanCallMe" SET DEFAULT 'EVERYONE';
