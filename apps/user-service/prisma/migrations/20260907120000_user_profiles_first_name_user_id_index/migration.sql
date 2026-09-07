-- People search pages with a keyset cursor over ORDER BY "firstName" ASC, "userId" ASC.
--
-- The existing ("firstName","lastName") index cannot serve that sort — lastName is the
-- wrong second column — so every page sorted the entire match set. This index matches
-- the ORDER BY and the cursor's (firstName, userId) comparison exactly.
--
-- Plain CREATE INDEX, not CONCURRENTLY: prisma migrate runs each migration inside a
-- transaction and CONCURRENTLY cannot join one. It briefly blocks writes to the table.

-- CreateIndex
CREATE INDEX "user_profiles_firstName_userId_idx" ON "user_profiles"("firstName", "userId");
