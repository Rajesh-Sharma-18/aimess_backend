import dotenv from "dotenv";

import { PrismaClient } from "../../src/generated/prisma/index.js";

// Load .env so the schema datasource `env("COMMUNITY_DATABASE_URL")` resolves
// with the full connection string (incl. directConnection=true for standalone
// Mongo). Without this the URL is undefined when run via `tsx`.
dotenv.config();

/**
 * One-off backfill for the denormalized `Community.categoryName` column added to
 * support the admin list's DB-level category sort. Pre-existing communities have
 * no `categoryName` until this runs; the sort tolerates a null value (id tiebreak
 * keeps paging deterministic), but the column should be populated so category
 * sort orders every row.
 *
 * Idempotent + resumable: each pass only touches rows where `categoryName` is
 * still unset, in `BATCH`-sized id-cursor pages, resolving the name from the
 * related category. Safe to re-run. Run via:
 *   pnpm --filter @aimess/community-service db:backfill:category-name
 */
const BATCH = 500;

const prisma = new PrismaClient();

async function main(): Promise<void> {
  let updated = 0;
  let cursorId: string | undefined;

  // Cache category id -> name so we don't re-read the (small) category set.
  const nameByCategoryId = new Map<string, string>();
  for (const c of await prisma.communityCategory.findMany({
    select: { id: true, name: true },
  })) {
    nameByCategoryId.set(c.id, c.name);
  }

  for (;;) {
    const rows = await prisma.community.findMany({
      where: { categoryName: null },
      orderBy: { id: "asc" },
      take: BATCH,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      select: { id: true, categoryId: true },
    });
    if (rows.length === 0) break;
    cursorId = rows[rows.length - 1]!.id;

    for (const row of rows) {
      const name = nameByCategoryId.get(row.categoryId);
      // A community pointing at a deleted/unknown category keeps a null name —
      // skip rather than write "" so a later category fix can still backfill it.
      if (!name) continue;
      await prisma.community.update({
        where: { id: row.id },
        data: { categoryName: name },
      });
      updated += 1;
    }

    // eslint-disable-next-line no-console
    console.log(
      `Backfilled categoryName for ${String(updated)} communities...`
    );
  }

  // eslint-disable-next-line no-console
  console.log(
    `Done. Backfilled categoryName for ${String(updated)} communities.`
  );
}

main()
  .catch((error: unknown) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
