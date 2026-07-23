/**
 * One-off backfill: populates `normalizedUsername`/`normalizedFirstName`/
 * `normalizedLastName`/`normalizedFullName` for every pre-existing
 * UserProfile row (new/updated rows get these set at write-time by
 * `userProfileRepository.createFromRegistration`/`updateProfile`).
 *
 * Safe to re-run — it's idempotent (recomputes from the current
 * username/firstName/lastName every time) and skips rows that already
 * match, so a second run is a no-op.
 *
 * Usage: pnpm --filter @aimess/user-service db:backfill:normalized-search
 */
import { prisma } from "../src/config/prisma.js";
import {
  normalizeForSearch,
  buildNormalizedFullName,
} from "../src/lib/user-search.util.js";

async function backfillNormalizedSearchFields() {
  const profiles = await prisma.userProfile.findMany({
    select: {
      userId: true,
      username: true,
      firstName: true,
      lastName: true,
      normalizedUsername: true,
      normalizedFirstName: true,
      normalizedLastName: true,
      normalizedFullName: true,
    },
  });

  console.log(`Found ${profiles.length} profiles to check.`);

  let updated = 0;
  const batchSize = 50;
  for (let i = 0; i < profiles.length; i += batchSize) {
    const batch = profiles.slice(i, i + batchSize);
    await Promise.all(
      batch.map((p) => {
        const normalizedUsername = normalizeForSearch(p.username);
        const normalizedFirstName = normalizeForSearch(p.firstName);
        const normalizedLastName = normalizeForSearch(p.lastName);
        const normalizedFullName = buildNormalizedFullName(
          p.firstName,
          p.lastName
        );
        if (
          normalizedUsername === p.normalizedUsername &&
          normalizedFirstName === p.normalizedFirstName &&
          normalizedLastName === p.normalizedLastName &&
          normalizedFullName === p.normalizedFullName
        ) {
          return Promise.resolve();
        }
        updated += 1;
        return prisma.userProfile.update({
          where: { userId: p.userId },
          data: {
            normalizedUsername,
            normalizedFirstName,
            normalizedLastName,
            normalizedFullName,
          },
        });
      })
    );
    console.log(
      `Processed ${Math.min(i + batchSize, profiles.length)}/${profiles.length}...`
    );
  }

  console.log(`Done — updated ${updated}/${profiles.length} profiles.`);
}

backfillNormalizedSearchFields()
  .catch((err) => {
    console.error("Backfill failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
