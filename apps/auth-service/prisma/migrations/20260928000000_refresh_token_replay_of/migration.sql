-- Marks a refresh token minted to answer a benign replay of an already-rotated
-- token, so a lost refresh response can be recovered long after the 60s grace
-- without letting two holders alternate on one chain. Nullable, no backfill.
ALTER TABLE "refresh_tokens"
  ADD COLUMN "replayOfId" UUID;
