-- Provider email vs profile email, and the primary-account backfill.
--
-- `linked_accounts.email` is the address the PROVIDER reported. It has always
-- existed, but nothing recorded whether the provider actually asserted it in a
-- signed token, so it could not safely be used to resolve an account. This adds
-- that flag, because social sign-in now looks accounts up by it: a Google/Apple
-- sign-in no longer copies its address into `auth_users.email` (the profile
-- email the user links by hand), so the provider link is the only place that
-- address lives.
ALTER TABLE "linked_accounts"
  ADD COLUMN "emailVerified" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "linked_accounts_email_emailVerified_idx"
  ON "linked_accounts" ("email", "emailVerified");

-- Existing Google links are known-verified: `verifyGoogleIdToken` has always
-- rejected a token without `email_verified`, and the sign-in path refuses to
-- auto-link an unverified address. Apple rows are left false on purpose — the
-- manual-link path accepted a client-supplied address for them, so they are not
-- provably provider-asserted and must stay display-only.
UPDATE "linked_accounts"
SET "emailVerified" = true
WHERE "provider" = 'GOOGLE' AND "email" IS NOT NULL;

-- Backfill `primaryAccount` for accounts predating it.
--
-- Pure-social accounts (no password) can only have been created by a provider
-- sign-in, so the earliest link is unambiguously the first sign-in method.
UPDATE "auth_users" u
SET "primaryAccount" = first_link."provider"
FROM (
  SELECT DISTINCT ON ("userId") "userId", "provider"
  FROM "linked_accounts"
  ORDER BY "userId", "linkedAt" ASC
) AS first_link
WHERE u."id" = first_link."userId"
  AND u."primaryAccount" IS NULL
  AND u."passwordHash" IS NULL;

-- A password account that has a verified email got that email by linking it by
-- hand — the only path that writes `auth_users.email` on such an account.
UPDATE "auth_users"
SET "primaryAccount" = 'EMAIL'
WHERE "primaryAccount" IS NULL
  AND "passwordHash" IS NOT NULL
  AND "email" IS NOT NULL
  AND "emailVerified" = true;

-- A password account with no linked email keeps primaryAccount = NULL, which is
-- the specified state for it.
