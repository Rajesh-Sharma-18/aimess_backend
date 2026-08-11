-- Durable "were these two EVER friends?" marker.
--
-- A friendship row is recycled, not replaced, when a rejected/cancelled/
-- unfriended pair sends a new request (`resetToPending`), and that reset nulls
-- `acceptedAt`. So neither the row's existence nor `acceptedAt` can tell a
-- first-time friendship from a re-friendship — and the chat "You and X are now
-- friends" system message must only be posted for the latter.
--
-- Written once, on the first acceptance, and never cleared again.
ALTER TABLE "friendships"
  ADD COLUMN "firstAcceptedAt" TIMESTAMPTZ(3);

-- Backfill: every pair that is friends RIGHT NOW has demonstrably been accepted
-- at least once, so a later unfriend → re-friend must count as a re-friendship.
-- Pairs that were already unfriended before this column existed are
-- unrecoverable (their `acceptedAt` was wiped on the reset) and stay NULL —
-- their next acceptance reads as first-time. One-off, historical only.
UPDATE "friendships"
   SET "firstAcceptedAt" = "acceptedAt"
 WHERE "status" = 'ACCEPTED'
   AND "acceptedAt" IS NOT NULL;
