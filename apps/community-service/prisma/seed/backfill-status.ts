import dotenv from "dotenv";

import { PrismaClient } from "../../src/generated/prisma/index.js";

dotenv.config();

/**
 * One-off backfill for `Community.status` (owner-controlled lifecycle status,
 * ACTIVE | CLOSED). Pre-existing communities have no `status` field until this
 * runs, which causes Prisma to throw a non-nullable field error on read.
 *
 * Strategy: set `status = "ACTIVE"` for every community that lacks the field
 * (or has it null), matching the field's default. Every legacy community was
 * open, so ACTIVE is the correct value.
 *
 * Uses $runCommandRaw because Prisma's generated client rejects null-queries on
 * non-nullable enum fields. Idempotent: the `q` filter only matches documents
 * where `status` is absent or null. Safe to re-run. Run via:
 *   pnpm --filter @aimess/community-service db:backfill:status
 */

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const result = await prisma.$runCommandRaw({
    update: "communities",
    updates: [
      {
        q: { status: { $in: [null] } },
        u: { $set: { status: "ACTIVE" } },
        multi: true,
      },
    ],
  });

  const modified = (result as { nModified?: number }).nModified ?? 0;
  // eslint-disable-next-line no-console
  console.log(
    `Done. Backfilled status=ACTIVE for ${String(modified)} communities.`
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
