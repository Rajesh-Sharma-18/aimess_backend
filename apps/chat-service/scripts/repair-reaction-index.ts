/**
 * One-time repair: rebuild the reactor index for every message that was
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
 * Rebuilds in place rather than only re-arming `reactionsIndexedAt`. Leaving the
 * duplicates for the next paginated read to clear would mean a message nobody
 * opens keeps wrong counts indefinitely, and — more pressingly — a unique index
 * cannot be created over a collection that still contains the duplicates it is
 * meant to forbid, so `prisma db push` would fail until this has run.
 *
 * Only messages that HAVE a projection are touched; the rest have nothing to
 * repair and are built correctly on first read. Idempotent: a second run
 * rewrites the same rows from the same authoritative map.
 *
 *   pnpm --filter @aimess/chat-service repair:reaction-index
 */
import { logger } from "@aimess/logger";

import { prisma } from "../src/config/prisma.js";
import { MessageReactionRepository } from "../src/repositories/message-reaction.repository.js";
import type { ReactionConversationType } from "../src/repositories/message-reaction.repository.js";

const index = new MessageReactionRepository(prisma);

interface MessageRow {
  id: string;
  roomId: string;
  reactions: unknown;
  createdAt: Date;
}

const LOADERS: Record<
  ReactionConversationType,
  (ids: string[]) => Promise<MessageRow[]>
> = {
  PRIVATE: (ids) =>
    prisma.privateMessage.findMany({
      where: { id: { in: ids } },
      select: { id: true, roomId: true, reactions: true, createdAt: true },
    }),
  GROUP: (ids) =>
    prisma.groupMessage.findMany({
      where: { id: { in: ids } },
      select: { id: true, roomId: true, reactions: true, createdAt: true },
    }),
  COMMUNITY: (ids) =>
    prisma.generalRoomMessage.findMany({
      where: { id: { in: ids } },
      select: { id: true, roomId: true, reactions: true, createdAt: true },
    }),
};

async function repair(): Promise<void> {
  // Every message the projection knows about, with how many rows it holds.
  const indexed = await prisma.messageReaction.groupBy({
    by: ["messageId", "conversationType"],
    _count: { _all: true },
  });
  logger.info(
    `Repair(reaction-index): ${String(indexed.length)} message(s) have a reactor index`
  );

  const byType = new Map<ReactionConversationType, Map<string, number>>();
  for (const row of indexed) {
    const type = row.conversationType as ReactionConversationType;
    if (!LOADERS[type]) {
      logger.warn(
        `Repair(reaction-index): unknown conversationType ${row.conversationType}, skipping`
      );
      continue;
    }
    if (!byType.has(type)) byType.set(type, new Map());
    byType.get(type)!.set(row.messageId, row._count._all);
  }

  let rebuilt = 0;
  let removed = 0;
  let orphaned = 0;

  for (const [type, counts] of byType) {
    const ids = [...counts.keys()];
    const messages = await LOADERS[type](ids);
    const found = new Set(messages.map((m) => m.id));

    // A projection whose message is gone (deleted, or auto-deleted) can only
    // contribute wrong numbers to something that still reads it.
    for (const id of ids) {
      if (found.has(id)) continue;
      await index.deleteForMessage(id, type);
      orphaned += 1;
    }

    for (const message of messages) {
      const before = counts.get(message.id) ?? 0;
      await index.materializeFromStoredMap({
        messageId: message.id,
        conversationType: type,
        roomId: message.roomId,
        storedReactions: message.reactions,
        baseTime: message.createdAt,
      });
      const after = await prisma.messageReaction.count({
        where: { messageId: message.id, conversationType: type },
      });
      rebuilt += 1;
      if (after !== before) {
        removed += before - after;
        logger.info(
          `Repair(reaction-index): ${type} ${message.id} ${String(before)} -> ${String(after)} row(s)`
        );
      }
    }
  }

  logger.info(
    `Repair(reaction-index): done — rebuilt ${String(rebuilt)} message(s), removed ${String(removed)} duplicate row(s), dropped ${String(orphaned)} orphaned index(es)`
  );
}

repair()
  .catch((err: unknown) => {
    logger.error(`Repair(reaction-index) failed: ${String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
