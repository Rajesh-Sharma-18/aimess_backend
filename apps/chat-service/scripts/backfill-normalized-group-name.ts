/**
 * One-off backfill: populates `normalizedName` for every pre-existing
 * GroupRoom (new rows get it set at write-time by
 * `groupRoomRepository.create`/`updateRoom`).
 *
 * Safe to re-run — idempotent, recomputes from the current name every time
 * and skips rows that already match.
 *
 * Usage: pnpm --filter @aimess/chat-service db:backfill:normalized-group-name
 */
import { prisma } from "../src/config/prisma.js";
import { normalizeForSearch } from "../src/lib/group-search.util.js";

async function backfillNormalizedGroupName() {
  const groups = await prisma.groupRoom.findMany({
    select: { id: true, name: true, normalizedName: true },
  });

  console.log(`Found ${groups.length} groups to check.`);

  let updated = 0;
  const batchSize = 50;
  for (let i = 0; i < groups.length; i += batchSize) {
    const batch = groups.slice(i, i + batchSize);
    await Promise.all(
      batch.map((g) => {
        const normalizedName = normalizeForSearch(g.name);
        if (normalizedName === g.normalizedName) return Promise.resolve();
        updated += 1;
        return prisma.groupRoom.update({
          where: { id: g.id },
          data: { normalizedName },
        });
      })
    );
    console.log(
      `Processed ${Math.min(i + batchSize, groups.length)}/${groups.length}...`
    );
  }

  console.log(`Done — updated ${updated}/${groups.length} groups.`);
}

backfillNormalizedGroupName()
  .catch((err) => {
    console.error("Backfill failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
