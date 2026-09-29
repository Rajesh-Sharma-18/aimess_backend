/**
 * One-off cleanup: delete private rooms whose `participants` are not two
 * distinct user UUIDs.
 *
 * How they were written: `UserServiceClient.checkFriendship` fails OPEN (an
 * unresolved upstream and a DB error both `return true`) and
 * `POST/GET /chat/private/rooms/:peerId` never validated the param, so during
 * any user-service blip a room was minted for whatever string sat in the URL.
 * The dev database holds 24 of them — a `grp_` room id, the literal
 * "undefined", a UUID with junk appended. `lib/room-id.ts`'s
 * `assertPrivateParticipants` now refuses to create such a room; this removes
 * the ones already written.
 *
 * Why they must go rather than be repaired: there is nothing to repair TO. The
 * peer id is not a redacted or stale user id, it is a string that never named
 * anybody, so the row describes a conversation between one real person and
 * nothing. `enrichConversations` would serialize it with a placeholder name
 * forever.
 *
 * REFUSES to delete a room that has any history — `lastMessageAt`, a
 * `lastMessageId`, or any row in `private_messages`. Every known malformed
 * room is empty, so this should never trigger; if it does, the room is not
 * what this script was written for and the user must look at it before
 * anything is destroyed. Pass `--force-nonempty` only after doing so.
 *
 * Deletion is permanent. Dry run is the default and prints every room it would
 * remove.
 *
 * Dry run (default, writes nothing):
 *   pnpm --filter @aimess/chat-service purge:malformed-private-rooms
 * Apply:
 *   pnpm --filter @aimess/chat-service purge:malformed-private-rooms -- --apply
 */
import { logger } from "@aimess/logger";

import { prisma } from "../src/config/prisma.js";
import { isUserId } from "../src/lib/room-id.js";

const APPLY = process.argv.includes("--apply");
const FORCE_NONEMPTY = process.argv.includes("--force-nonempty");

/** Same invariant `assertPrivateParticipants` enforces on write, as a predicate. */
function isMalformed(participants: string[]): boolean {
  const [a, b] = participants ?? [];
  return (
    (participants ?? []).length !== 2 || !isUserId(a) || !isUserId(b) || a === b
  );
}

/** What is wrong with this row, for the log — the whole point of the dry run. */
function describe(participants: string[]): string {
  return (participants ?? [])
    .map((p) => {
      if (isUserId(p)) return `${p} (ok)`;
      if (typeof p !== "string") return `${String(p)} (not a string)`;
      if (p.startsWith("grp_")) return `${p} (GROUP room id)`;
      if (p.startsWith("prv_")) return `${p} (PRIVATE room id)`;
      if (p === "") return `"" (empty)`;
      return `${p} (not a user id)`;
    })
    .join("  +  ");
}

async function purgeMalformedPrivateRooms(): Promise<void> {
  // Read every room and filter in memory: "participants[i] is not a UUID" is
  // not a query Mongo can index, and the collection is small enough that one
  // projected scan is cheaper than being clever about it.
  const rooms = await prisma.privateRoom.findMany({
    select: {
      roomId: true,
      participants: true,
      lastMessageAt: true,
      lastMessageId: true,
      createdAt: true,
    },
  });

  const malformed = rooms.filter((r) => isMalformed(r.participants));

  logger.info(
    `purge(malformed-private-rooms): ${String(malformed.length)} of ${String(
      rooms.length
    )} room(s) malformed${APPLY ? "" : " — DRY RUN, pass --apply to delete"}`
  );
  if (malformed.length === 0) return;

  const deletable: string[] = [];
  const skipped: string[] = [];

  for (const room of malformed) {
    // Three independent signals, because a counter and a pointer can drift:
    // ask the messages collection itself as well as the room's own fields.
    const messageCount = await prisma.privateMessage.count({
      where: { roomId: room.roomId },
    });
    const hasHistory =
      messageCount > 0 || room.lastMessageAt !== null || !!room.lastMessageId;

    logger.info(
      `  ${room.roomId}  [${describe(room.participants)}]  messages=${String(
        messageCount
      )}  lastMessageAt=${room.lastMessageAt?.toISOString() ?? "null"}  created=${room.createdAt.toISOString()}`
    );

    if (hasHistory && !FORCE_NONEMPTY) {
      skipped.push(room.roomId);
      logger.warn(
        `    SKIPPED — this room has history. Look at it before deleting anything; pass --force-nonempty only once you have.`
      );
      continue;
    }
    deletable.push(room.roomId);
  }

  if (!APPLY) {
    logger.info(
      `purge(malformed-private-rooms): would delete ${String(
        deletable.length
      )} room(s), skip ${String(skipped.length)}`
    );
    return;
  }

  if (deletable.length === 0) {
    logger.info(`purge(malformed-private-rooms): nothing to delete`);
    return;
  }

  // Messages first: a room deleted while rows still point at it leaves
  // unreachable history. Normally a no-op (these rooms are empty) — it only
  // does anything under --force-nonempty.
  const messagesDeleted = await prisma.privateMessage.deleteMany({
    where: { roomId: { in: deletable } },
  });
  const roomsDeleted = await prisma.privateRoom.deleteMany({
    where: { roomId: { in: deletable } },
  });

  logger.info(
    `purge(malformed-private-rooms): deleted ${String(
      roomsDeleted.count
    )} room(s) and ${String(messagesDeleted.count)} message(s); skipped ${String(
      skipped.length
    )}`
  );
}

purgeMalformedPrivateRooms()
  .catch((err) => {
    logger.error(`purge(malformed-private-rooms) failed: ${String(err)}`);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
