/**
 * One-off backfill (AIMESS-231, AIMESS-237): every group holds 256 members, so any
 * stored memberLimit other than MAX_GROUP_MEMBERS (Android's old 50, test rows,
 * legacy 5000) is normalised to it.
 *
 * Safe to re-run — idempotent.
 *
 * Usage: pnpm --filter @aimess/chat-service db:backfill:group-member-limit-256
 */
import { MAX_GROUP_MEMBERS } from "@aimess/constants";

import { prisma } from "../src/config/prisma.js";

async function backfillGroupMemberLimit() {
  const result = await prisma.groupRoom.updateMany({
    where: { memberLimit: { not: MAX_GROUP_MEMBERS } },
    data: { memberLimit: MAX_GROUP_MEMBERS },
  });
  console.log(`Done — updated ${result.count} GroupRoom row(s) memberLimit -> ${MAX_GROUP_MEMBERS}.`);
}

backfillGroupMemberLimit()
  .catch((err) => {
    console.error("Backfill failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
