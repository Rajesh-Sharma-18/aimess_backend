/**
 * One-time backfill: seed `lastReadAt = joinedAt` for every `RoomMember` whose
 * `lastReadAt` is still NULL.
 *
 * Why: community unread is DERIVED from `RoomMember.lastReadAt` via
 * `countUnreadBulk`, which uses `afterDate = lastReadAt ?? new Date(0)`. A NULL
 * pointer therefore counts EVERY pre-join community-wide message as unread — a
 * phantom badge on the list the moment you join (and on every reload until the
 * member opens the room once). The create path now seeds the pointer to the join
 * time (see RoomMemberRepository.upsert); this backfills members created before
 * that fix.
 *
 * Correctness: `joinedAt` is the exact boundary — messages sent BEFORE a member
 * joined were never theirs to read, and messages sent AFTER still satisfy
 * `createdAt > joinedAt` so they remain counted as unread. So this zeros only the
 * phantom (pre-join) portion, never real unread. A read path only ever SETS
 * `lastReadAt` to a Date, so NULL uniquely identifies a never-read member — this
 * can never regress a real read pointer.
 *
 * Idempotent: touches only rows whose pointer is UNSET; re-runs are no-ops.
 *
 * Prisma-Mongo gotcha: a never-written optional field is MISSING, not JSON
 * `null`, and `{ lastReadAt: null }` matches only explicit nulls (zero rows
 * here). `{ isSet: false }` is the filter that matches the unset legacy rows.
 *
 *   pnpm --filter @aimess/chat-service exec tsx scripts/backfill-member-read-pointer.ts
 */
import { logger } from "@aimess/logger";

import { prisma } from "../src/config/prisma.js";

async function main(): Promise<void> {
  const members = await prisma.roomMember.findMany({
    where: { lastReadAt: { isSet: false } },
    select: { roomId: true, userId: true, joinedAt: true },
  });
  logger.info(`Backfill(read-pointer): ${String(members.length)} member(s)`);

  let updated = 0;
  for (const m of members) {
    await prisma.roomMember.update({
      where: { roomId_userId: { roomId: m.roomId, userId: m.userId } },
      data: { lastReadAt: m.joinedAt },
    });
    updated += 1;
  }

  await prisma.$disconnect();
  logger.info(`Backfill(read-pointer): done, updated ${String(updated)}`);
}

main().catch((error: unknown) => {
  logger.error("Member read-pointer backfill failed");
  logger.error(error);
  void prisma.$disconnect();
  process.exitCode = 1;
});
