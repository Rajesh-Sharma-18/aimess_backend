/**
 * One-off migration for AUDIT-109.
 *
 * Disband used to flip `GroupRoom.status` to DISBANDED and stop there. No
 * authorization path reads that field — every guard resolves a `GroupMember`
 * row — so groups disbanded before the fix still hold ACTIVE memberships and
 * still accept messages, reactions and pins.
 *
 * This ends those memberships the way `disbandGroup` now does: status LEFT with
 * `leftAt` set to the room's own `disbandedAt`, so the read cutoff
 * (`assertGroupReadAccess`) and the room's timestamp can never disagree. The
 * group then behaves like one you left — visible, read-only, dead.
 *
 * Per-room rather than one bulk update precisely so each room's `leftAt` matches
 * ITS disbandedAt. A room missing that timestamp (older rows) falls back to
 * `updatedAt`, then to now.
 *
 * Safe to re-run — only touches rows still ACTIVE in a DISBANDED room.
 *
 * Dry run (default, writes nothing):
 *   pnpm --filter @aimess/chat-service migrate:disbanded-group-members
 * Apply:
 *   pnpm --filter @aimess/chat-service migrate:disbanded-group-members -- --apply
 */
import { logger } from "@aimess/logger";

import { prisma } from "../src/config/prisma.js";

const APPLY = process.argv.includes("--apply");

async function migrateDisbandedGroupMembers(): Promise<void> {
  const rooms = await prisma.groupRoom.findMany({
    where: { status: "DISBANDED" },
    select: { roomId: true, disbandedAt: true, updatedAt: true },
  });

  logger.info(
    `migrate(disbanded-members): ${String(rooms.length)} disbanded room(s)${
      APPLY ? "" : " — DRY RUN, pass --apply to write"
    }`
  );

  let roomsTouched = 0;
  let membersEnded = 0;

  for (const room of rooms) {
    const leftAt = room.disbandedAt ?? room.updatedAt ?? new Date();

    if (!APPLY) {
      const count = await prisma.groupMember.count({
        where: { roomId: room.roomId, status: "ACTIVE" },
      });
      if (count === 0) continue;
      roomsTouched++;
      membersEnded += count;
      logger.info(
        `  would end ${String(count)} membership(s) in ${room.roomId} at ${leftAt.toISOString()}`
      );
      continue;
    }

    const result = await prisma.groupMember.updateMany({
      where: { roomId: room.roomId, status: "ACTIVE" },
      data: { status: "LEFT", leftAt },
    });
    if (result.count === 0) continue;
    roomsTouched++;
    membersEnded += result.count;
    logger.info(
      `  ended ${String(result.count)} membership(s) in ${room.roomId} at ${leftAt.toISOString()}`
    );
  }

  logger.info(
    `migrate(disbanded-members): ${APPLY ? "done" : "would touch"} — ${String(
      membersEnded
    )} membership(s) across ${String(roomsTouched)} room(s)`
  );
}

migrateDisbandedGroupMembers()
  .catch((err) => {
    logger.error(`migrate(disbanded-members) failed: ${String(err)}`);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
