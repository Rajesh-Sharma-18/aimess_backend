-- Usernames are unique IGNORING CASE, enforced by the database.
--
-- Every write path has stored usernames lowercase since the first commit
-- (`normalizeUsername`), so UNIQUE(username) already behaved case-insensitively
-- for rows the app wrote — but nothing stopped a direct/admin write of
-- "Rajesh_Sharma" next to "rajesh_sharma". This index does.
--
-- Cannot fail on data the app wrote. Before deploying to an environment whose
-- rows may have been edited by hand, run the read-only audit:
--   pnpm --filter @aimess/user-service audit:handle-case
-- (shared dev, 2026-10-05: 0 mixed-case usernames, 0 clashes).
--
-- Plain CREATE INDEX, not CONCURRENTLY: prisma migrate runs each migration in a
-- transaction, which CONCURRENTLY cannot join.

CREATE UNIQUE INDEX "user_profiles_username_lower_key" ON "user_profiles" (lower("username"));
