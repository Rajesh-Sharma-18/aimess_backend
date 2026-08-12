/**
 * One-off repair for the `memberNumber` drift AUDIT-101 exposed.
 *
 * `CommunityRoomService.join` incremented `GeneralRoom.memberNumber` on every
 * call, on top of the increment the `community.member.synced` consumer already
 * applies — so each join counted twice, and a client that re-issued join (a
 * retry, a reconnect, a second device) inflated it further. The route no longer
 * touches the counter; this recomputes it from the rows that are the actual
 * truth.
 *
 * Authority is chat-service's own `RoomMember` mirror with `status = "active"`,
 * which is what the count is meant to describe and what the sync consumer
 * maintains. Rooms already holding the right number are left alone.
 *
 * Safe to re-run — it is a recompute, not a delta.
 *
 * Dry run (default, writes nothing):
 *   pnpm --filter @aimess/chat-service migrate:community-member-number
 * Apply:
 *   pnpm --filter @aimess/chat-service migrate:community-member-number -- --apply
 */
import { logger } from "@aimess/logger";

import { prisma } from "../src/config/prisma.js";

const APPLY = process.argv.includes("--apply");

async function recomputeMemberNumber(): Promise<void> {
  const rooms = await prisma.generalRoom.findMany({
    select: { id: true, memberNumber: true },
  });

  logger.info(
    `recompute(memberNumber): ${String(rooms.length)} community room(s)${
      APPLY ? "" : " — DRY RUN, pass --apply to write"
    }`
  );

  let drifted = 0;
  let totalOvercount = 0;

  for (const room of rooms) {
    const actual = await prisma.roomMember.count({
      where: { roomId: room.id, status: "active" },
    });
    const stored = room.memberNumber ?? 0;
    if (stored === actual) continue;

    drifted++;
    totalOvercount += stored - actual;
    logger.info(
      `  ${room.id}: stored=${String(stored)} actual=${String(actual)} drift=${String(
        stored - actual
      )}`
    );

    if (APPLY) {
      await prisma.generalRoom.update({
        where: { id: room.id },
        data: { memberNumber: actual },
      });
    }
  }

  logger.info(
    `recompute(memberNumber): ${APPLY ? "corrected" : "would correct"} ${String(
      drifted
    )} room(s); net stored-minus-actual was ${String(totalOvercount)}`
  );
}

recomputeMemberNumber()
  .catch((err) => {
    logger.error(`recompute(memberNumber) failed: ${String(err)}`);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
