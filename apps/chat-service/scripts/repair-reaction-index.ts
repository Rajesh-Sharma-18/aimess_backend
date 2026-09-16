/**
 * One-time repair: re-arm the reactor index for every message that was
 * materialized by the version of `materializeFromStoredMap` that APPENDED the
 * stored map instead of rebuilding from it.
 *
 * That version inserted every reactor in the message's `reactions` map without
 * checking what the write path had already written. A message that received a
 * reaction BEFORE its projection was first built therefore ended up with two
 * rows for that reactor, and every count read off the projection was inflated —
 * a message with seven real reactions reported ten, with the extra three spread
 * across whichever emoji their duplicated owners had used.
 *
 * The fix is lazy rather than bulk. Clearing `reactionsIndexedAt` is the only
 * write this makes: the next paginated read of each message rebuilds its
 * projection from the map, and the repaired `materializeFromStoredMap` now
 * clears before it inserts, so the rebuild is exact. Messages nobody opens keep
 * their stale rows harmlessly — nothing reads the projection until the popup
 * does, and that read is what repairs it.
 *
 * Idempotent, and safe to run while the service is up.
 *
 *   pnpm --filter @aimess/chat-service repair:reaction-index
 */
import { logger } from "@aimess/logger";

import { prisma } from "../src/config/prisma.js";

async function rearm(
  label: string,
  model: {
    updateMany(args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
  }
): Promise<number> {
  // `not: null` and not `isSet: true`: the column exists only on rows that were
  // actually stamped, which is exactly the set that needs re-arming.
  const { count } = await model.updateMany({
    where: { reactionsIndexedAt: { not: null } },
    data: { reactionsIndexedAt: null },
  });
  logger.info(`Repair(reaction-index): ${label} re-armed ${String(count)} message(s)`);
  return count;
}

async function main(): Promise<void> {
  const total =
    (await rearm("private", prisma.privateMessage)) +
    (await rearm("group", prisma.groupMessage)) +
    (await rearm("community", prisma.generalRoomMessage));

  logger.info(
    `Repair(reaction-index): done — ${String(total)} message(s) will rebuild their reactor index on next read`
  );
}

main()
  .catch((err: unknown) => {
    logger.error(`Repair(reaction-index) failed: ${String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
