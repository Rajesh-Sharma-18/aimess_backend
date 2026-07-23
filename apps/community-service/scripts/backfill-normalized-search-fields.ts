/**
 * One-off backfill: populates `normalizedName`/`normalizedHandle` for every
 * pre-existing community row (new rows get these set at write-time by
 * `communityRepository.createCommunity`/`updateCommunity`).
 *
 * Safe to re-run — it's idempotent (recomputes from the current name/handle
 * every time) and skips rows that already match, so a second run is a no-op.
 *
 * Usage: pnpm --filter @aimess/community-service db:backfill:normalized-search
 */
import { prisma } from "../src/config/prisma.js";
import { normalizeForSearch } from "../src/lib/community-search.util.js";

async function backfillNormalizedSearchFields() {
  const communities = await prisma.community.findMany({
    select: {
      id: true,
      name: true,
      handle: true,
      normalizedName: true,
      normalizedHandle: true,
    },
  });

  console.log(`Found ${communities.length} communities to check.`);

  let updated = 0;
  const batchSize = 50;
  for (let i = 0; i < communities.length; i += batchSize) {
    const batch = communities.slice(i, i + batchSize);
    await Promise.all(
      batch.map((c) => {
        const normalizedName = normalizeForSearch(c.name);
        const normalizedHandle = normalizeForSearch(c.handle);
        if (
          normalizedName === c.normalizedName &&
          normalizedHandle === c.normalizedHandle
        ) {
          return Promise.resolve();
        }
        updated += 1;
        return prisma.community.update({
          where: { id: c.id },
          data: { normalizedName, normalizedHandle },
        });
      })
    );
    console.log(
      `Processed ${Math.min(i + batchSize, communities.length)}/${communities.length}...`
    );
  }

  console.log(`Done — updated ${updated}/${communities.length} communities.`);
}

backfillNormalizedSearchFields()
  .catch((err) => {
    console.error("Backfill failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
