/**
 * One-time backfill: assign per-room monotonic `sequenceNumber` to existing
 * PrivateMessage / GroupMessage rows, and set each room's `lastSequence` to the
 * highest assigned value.
 *
 * Ordering: messages are sequenced by `createdAt asc, id asc` (id is a tiebreaker
 * for messages sharing a timestamp), assigned 1..N. The room's `lastSequence` is
 * set to N so future allocations (privateRoom/groupRoom.lastSequence increment)
 * continue from there.
 *
 * Idempotent & resumable: a room is skipped when ALL its messages already have
 * sequenceNumber > 0 (i.e. it was already backfilled). A partially-processed room
 * (some rows still at 0) is re-sequenced from scratch — safe because the ordering
 * is deterministic.
 *
 *   pnpm --filter @aimess/chat-service backfill:seq
 */
import { logger } from "@aimess/logger";

import { prisma } from "../src/config/prisma.js";

async function backfillPrivateRooms(): Promise<void> {
  const rooms = await prisma.privateRoom.findMany({ select: { roomId: true } });
  logger.info(`Backfill(private): ${String(rooms.length)} room(s)`);

  for (const { roomId } of rooms) {
    const messages = await prisma.privateMessage.findMany({
      where: { roomId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, sequenceNumber: true },
    });

    if (messages.length === 0) continue;

    // Skip if every message already has a sequence (already backfilled).
    if (messages.every((m) => m.sequenceNumber > 0)) {
      logger.info(`Backfill(private): room ${roomId} already sequenced, skip`);
      continue;
    }

    let seq = 0;
    for (const m of messages) {
      seq += 1;
      await prisma.privateMessage.update({
        where: { id: m.id },
        data: { sequenceNumber: seq },
      });
    }
    await prisma.privateRoom.update({
      where: { roomId },
      data: { lastSequence: seq },
    });
    logger.info(
      `Backfill(private): room ${roomId} -> ${String(seq)} message(s)`
    );
  }
}

async function backfillGroupRooms(): Promise<void> {
  const rooms = await prisma.groupRoom.findMany({ select: { roomId: true } });
  logger.info(`Backfill(group): ${String(rooms.length)} room(s)`);

  for (const { roomId } of rooms) {
    const messages = await prisma.groupMessage.findMany({
      where: { roomId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, sequenceNumber: true },
    });

    if (messages.length === 0) continue;

    if (messages.every((m) => m.sequenceNumber > 0)) {
      logger.info(`Backfill(group): room ${roomId} already sequenced, skip`);
      continue;
    }

    let seq = 0;
    for (const m of messages) {
      seq += 1;
      await prisma.groupMessage.update({
        where: { id: m.id },
        data: { sequenceNumber: seq },
      });
    }
    await prisma.groupRoom.update({
      where: { roomId },
      data: { lastSequence: seq },
    });
    logger.info(`Backfill(group): room ${roomId} -> ${String(seq)} message(s)`);
  }
}

async function main(): Promise<void> {
  await backfillPrivateRooms();
  await backfillGroupRooms();
  await prisma.$disconnect();
  logger.info("Backfill(sequence-numbers): done");
}

main().catch((error: unknown) => {
  logger.error("Sequence-number backfill failed");
  logger.error(error);
  void prisma.$disconnect();
  process.exitCode = 1;
});
