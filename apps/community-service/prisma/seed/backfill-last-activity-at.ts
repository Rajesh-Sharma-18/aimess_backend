import dotenv from "dotenv";

import { PrismaClient } from "../../src/generated/prisma/index.js";

dotenv.config();

/**
 * One-off backfill for `Community.lastActivityAt` added for inbox-style
 * ordering. Pre-existing communities have no `lastActivityAt` until this runs,
 * which causes Prisma to throw a non-nullable field error on read.
 *
 * Strategy: set `lastActivityAt = createdAt` for every community that lacks
 * the field, matching the field's original intent ("initialized to createdAt
 * so message-less communities still sort by age").
 *
 * Uses $runCommandRaw because Prisma's generated client rejects null-queries
 * on non-nullable fields. The aggregation pipeline update (`[{$set: ...}]`)
 * lets MongoDB reference `$createdAt` server-side — no per-document round-trip.
 * Idempotent: the `q` filter only matches documents where the field is absent
 * or null. Safe to re-run. Run via:
 *   pnpm --filter @aimess/community-service db:backfill:last-activity-at
 */

const prisma = new PrismaClient();

async function main(): Promise<void> {
  // Single server-side update: for every Community document where
  // lastActivityAt doesn't exist or is null, set it to the document's own
  // createdAt value using an aggregation pipeline update.
  const result = await prisma.$runCommandRaw({
    update: "communities",
    updates: [
      {
        q: { lastActivityAt: { $in: [null] } },
        // Aggregation pipeline update — $set can reference other fields.
        u: [{ $set: { lastActivityAt: "$createdAt" } }],
        multi: true,
      },
    ],
  });

  const modified = (result as { nModified?: number }).nModified ?? 0;
  // eslint-disable-next-line no-console
  console.log(
    `Done. Backfilled lastActivityAt for ${String(modified)} communities.`
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
