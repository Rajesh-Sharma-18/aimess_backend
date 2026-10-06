-- Account names become unique IGNORING CASE ("Rajesh_Sharma" = "rajesh_sharma").
--
-- The existing UNIQUE(account) is case-sensitive, and accounts were stored with
-- whatever case the user typed, so differently-cased duplicates already exist
-- (the shared dev DB has 7 such groups). They are NOT renamed, merged or
-- deleted here — which account keeps the name is a product decision. Instead
-- every row of such a group is flagged `accountCaseConflict` and gets its own
-- id as the second index column, which exempts it from the case-insensitive
-- check. Every other row — legacy mixed-case included — is unique on
-- lower(account), and so is every row created from now on (never flagged).
--
-- A newcomer cannot slip in next to a flagged group either: registration checks
-- lower(account) against every row, and flagged rows can only come from this
-- migration, so there is no concurrent insert to race with.
--
-- Leading column lower(account) also serves the case-insensitive lookups
-- (`findByAccount` / `findByAccountForLogin`).
--
-- Never fails on existing data. The table lock (prisma migrate runs this file in
-- one transaction) stops a register from creating a new clash between the
-- UPDATE and the CREATE INDEX.
--
-- Resolving a group later: rename all but one member, then
--   UPDATE auth_users SET "accountCaseConflict" = false WHERE lower(account) = '<name>';
-- (the UPDATE itself fails with a unique violation while a clash remains).

ALTER TABLE "auth_users" ADD COLUMN "accountCaseConflict" BOOLEAN NOT NULL DEFAULT false;

LOCK TABLE "auth_users" IN SHARE ROW EXCLUSIVE MODE;

UPDATE "auth_users"
SET "accountCaseConflict" = true
WHERE lower("account") IN (
  SELECT lower("account") FROM "auth_users" GROUP BY 1 HAVING count(*) > 1
);

CREATE UNIQUE INDEX "auth_users_account_lower_key" ON "auth_users" (
  lower("account"),
  (CASE WHEN "accountCaseConflict" THEN "id"::text ELSE '' END)
);
