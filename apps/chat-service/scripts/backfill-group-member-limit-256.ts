/**
 * One-off backfill (AIMESS-231): Android created every group with memberLimit=50,
 * so those groups enforce 50 while the product cap is 256. Lifts exactly-50 rows to
 * MAX_GROUP_MEMBERS; deliberate small limits (1, 2 — limit tests) are left alone.
 *
 * Safe to re-run — idempotent.
 *
 * Usage: pnpm --filter @aimess/chat-service db:backfill:group-member-limit-256
 */
import { MAX_GROUP_MEMBERS } from "@aimess/constants";

import { prisma } from "../src/config/prisma.js";

async function backfillGroupMemberLimit() {
  const result = await prisma.groupRoom.updateMany({
    where: { memberLimit: 50 },
    data: { memberLimit: MAX_GROUP_MEMBERS },
  });
  console.log(`Done — updated ${result.count} GroupRoom row(s) memberLimit 50 -> ${MAX_GROUP_MEMBERS}.`);
}

backfillGroupMemberLimit()
  .catch((err) => {
    console.error("Backfill failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
