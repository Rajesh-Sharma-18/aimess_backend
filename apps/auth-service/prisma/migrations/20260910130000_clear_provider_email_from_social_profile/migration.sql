-- Legacy social accounts: take the provider address back out of the PROFILE email.
--
-- Until 20260910000000, a Google/Apple sign-UP wrote the provider address into
-- `auth_users.email` as well as onto the provider link. That column is the
-- email the user linked BY HAND -- it is what GET /users/profiles/me returns as
-- `email`, what the Settings "Email" row renders, and what makes the EMAIL
-- sign-in method report itself connected. So every account founded by a social
-- sign-in still looks like it has a verified AIMess email it never supplied,
-- and `emailVerified = true` on it makes the link-email flow refuse that same
-- address with AUTH_EMAIL_ALREADY_LINKED.
--
-- The previous migration fixed the code path and backfilled `primaryAccount`,
-- but left this column as it was. Clearing it is not a loss: the address stays
-- on `linked_accounts.email`, which is where sign-in resolves it and where
-- `googleEmail` / `appleEmail` are read from.
--
-- Scoped by the FOUNDING link -- a social link created in the same transaction
-- as the account row, hence within a moment of `createdAt`. A link added later
-- to an account that already existed carries no such claim on the profile
-- email, so an email account that linked Google afterwards is untouched.
--
-- `passwordHash IS NULL` keeps it to accounts with no password login. A social
-- account that has since set one through the forgot-password flow reaches
-- itself by this address (login by email, password reset), so its column is
-- left alone rather than cutting off the way in.
UPDATE "auth_users" u
SET "email" = NULL,
    "emailVerified" = false
WHERE u."email" IS NOT NULL
  AND u."passwordHash" IS NULL
  AND EXISTS (
    SELECT 1
    FROM "linked_accounts" l
    WHERE l."userId" = u."id"
      AND l."provider" IN ('GOOGLE', 'APPLE')
      AND lower(l."email") = lower(u."email")
      AND l."linkedAt" < u."createdAt" + interval '2 seconds'
  );

-- `primaryAccount` is the first sign-in method ever linked. For an account a
-- provider founded that is the provider, whatever happened afterwards -- but
-- two paths could still stamp EMAIL on one: hand-linking an email before
-- 20260910000000 (when social accounts carried a null primaryAccount for
-- setPrimaryAccountIfUnset to fill), and that migration's own password-account
-- branch, which claims any account holding a verified address and a password.
UPDATE "auth_users" u
SET "primaryAccount" = founding."provider"
FROM (
  SELECT DISTINCT ON (l."userId") l."userId", l."provider"
  FROM "linked_accounts" l
  JOIN "auth_users" a ON a."id" = l."userId"
  WHERE l."provider" IN ('GOOGLE', 'APPLE')
    AND l."linkedAt" < a."createdAt" + interval '2 seconds'
  ORDER BY l."userId", l."linkedAt" ASC
) AS founding
WHERE u."id" = founding."userId"
  AND u."primaryAccount" IS DISTINCT FROM founding."provider";
