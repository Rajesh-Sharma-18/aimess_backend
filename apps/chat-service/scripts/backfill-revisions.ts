/**
 * One-time backfill: assign a per-room CHANGE `revision` to existing
 * GeneralRoomMessage (community) rows, and set each `GeneralRoom.lastRevision`
 * to the highest assigned value.
 *
 * OPTIONAL. The zero-loss cold-start flow baselines from V2 history + the
 * response's `roomRevision`, so it works WITHOUT this backfill (old rows keep
 * revision 0 and simply don't appear in `/changes` until they're next mutated).
 * Run this only if you want `GET .../changes?since_revision=0` to also serve the
 * full historical baseline in revision order.
 *
 * Ordering: rows are revisioned by `createdAt asc, id asc` (id tiebreaker),
 * assigned 1..N; `lastRevision` is set to N so future `allocateRevision`
 * increments continue from there. Revision is community-scoped only — private/
 * group don't use it (they catch up on `sequenceNumber` via chat:catchup).
 *
 * Idempotent & resumable: a room whose rows ALL already have revision > 0 is
 * skipped; a partially-processed room is re-revisioned from scratch (the
 * ordering is deterministic).
 *
 *   pnpm --filter @aimess/chat-service backfill:revision
 */
import { logger } from "@aimess/logger";

import { prisma } from "../src/config/prisma.js";

async function backfillGeneralRoomRevisions(): Promise<void> {
  const rooms = await prisma.generalRoom.findMany({ select: { id: true } });
  logger.info(`Backfill(revision): ${String(rooms.length)} community room(s)`);

  for (const { id: roomId } of rooms) {
    const messages = await prisma.generalRoomMessage.findMany({
      where: { roomId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, revision: true },
    });

    if (messages.length === 0) continue;

    // Skip if every message already has a revision (already backfilled).
    if (messages.every((m) => m.revision > 0)) {
      logger.info(`Backfill(revision): room ${roomId} already done, skip`);
      continue;
    }

    let rev = 0;
    for (const m of messages) {
      rev += 1;
      await prisma.generalRoomMessage.update({
        where: { id: m.id },
        data: { revision: rev },
      });
    }
    await prisma.generalRoom.update({
      where: { id: roomId },
      data: { lastRevision: rev },
    });
    logger.info(`Backfill(revision): room ${roomId} -> ${String(rev)} row(s)`);
  }
}

async function main(): Promise<void> {
  await backfillGeneralRoomRevisions();
  await prisma.$disconnect();
  logger.info("Backfill(revisions): done");
}

main().catch((error: unknown) => {
  logger.error("Revision backfill failed");
  logger.error(error);
  void prisma.$disconnect();
  process.exitCode = 1;
});
