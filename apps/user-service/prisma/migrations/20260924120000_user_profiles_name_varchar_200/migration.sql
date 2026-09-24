-- WIDEN first/last name from VarChar(50) to VarChar(200).
--
-- The product limit is going DOWN (30 characters), not up — but "character" now
-- means a grapheme cluster, and Postgres counts code points. Thirty Thai
-- clusters are ~90 code points and thirty decomposed accented letters are ~60,
-- so a VarChar(50) column would reject names the 30-character rule is supposed
-- to allow, with a raw 22001 instead of a validation error. 200 matches
-- TEXT_NAME_MAX_RAW_LENGTH, the UTF-16 guard the validator applies first.
--
-- Widening only: no existing value can fail, nothing is truncated, and in
-- Postgres a varchar length increase is a catalog-only change (no table
-- rewrite, no lock beyond ACCESS EXCLUSIVE for the DDL itself).

-- AlterTable
ALTER TABLE "user_profiles"
  ALTER COLUMN "firstName" TYPE VARCHAR(200),
  ALTER COLUMN "lastName"  TYPE VARCHAR(200);
