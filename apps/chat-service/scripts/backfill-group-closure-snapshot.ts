/**
 * One-off backfill: closure roster snapshots for groups closed BEFORE
 * GroupClosureMember existed.
 *
 * A group's closure instant T is `closedAt` (system-ban close) or else
 * `disbandedAt`. GroupMember rows are never deleted, so the roster at T is
 * reconstructed from them: a member counts when they joined at/before T and
 * their membership had not ended before T —
 *   ACTIVE / BANNED            → still on the roster
 *   LEFT   with leftAt   >= T  → ended at or after the closure (a disband ends
 *                                every membership at exactly disbandedAt)
 *   KICKED with kickedAt >= T  → removed after the closure
 * Anything else (ended before T, or missing its timestamp) is excluded rather
 * than guessed. Identity is today's (the name at closure is not recorded
 * anywhere); a failed lookup stores blank identity, resolved live on read.
 *
 * A room with neither timestamp cannot be reconstructed and is reported and
 * left alone — the admin view keeps showing its live roster.
 *
 * Idempotent: only rooms with a null memberCountAtClosure are touched.
 *
 * Dry run (default, writes nothing):
 *   pnpm --filter @aimess/chat-service db:backfill:group-closure-snapshot
 * Apply:
 *   pnpm --filter @aimess/chat-service db:backfill:group-closure-snapshot -- --apply
 */
import { logger } from "@aimess/logger";

import { prisma } from "../src/config/prisma.js";
import { fetchUsersBatch } from "../src/lib/user-service-client.js";
import type { GroupMember } from "../src/generated/prisma/index.js";

const APPLY = process.argv.includes("--apply");

function wasOnRosterAt(m: GroupMember, t: Date): boolean {
  if (m.joinedAt > t) return false;
  if (m.status === "ACTIVE" || m.status === "BANNED") return true;
  if (m.status === "LEFT") return !!m.leftAt && m.leftAt >= t;
  if (m.status === "KICKED") return !!m.kickedAt && m.kickedAt >= t;
  return false;
}

async function main(): Promise<void> {
  const rooms = await prisma.groupRoom.findMany({
    where: {
      status: { in: ["DISBANDED", "CLOSED"] },
      // Unset on every pre-existing row; `null` alone matches only an explicit null.
      OR: [
        { memberCountAtClosure: null },
        { memberCountAtClosure: { isSet: false } },
      ],
    },
    select: { roomId: true, name: true, closedAt: true, disbandedAt: true },
  });
  logger.info(
    `backfill(closure-snapshot): ${String(rooms.length)} closed room(s) without a snapshot${
      APPLY ? "" : " — DRY RUN, pass --apply to write"
    }`
  );

  const unreconstructable: string[] = [];
  let done = 0;
  for (const room of rooms) {
    const t = room.closedAt ?? room.disbandedAt;
    if (!t) {
      unreconstructable.push(room.roomId);
      logger.warn(`  SKIP ${room.roomId} "${room.name}": no closure timestamp`);
      continue;
    }

    const members = await prisma.groupMember.findMany({
      where: { roomId: room.roomId },
    });
    const roster = members.filter((m) => wasOnRosterAt(m, t));
    const users = (await fetchUsersBatch(roster.map((m) => m.userId))) ?? [];
    const byId = new Map(users.map((u) => [u.userId, u]));

    logger.info(
      `  ${APPLY ? "snapshot" : "would snapshot"} ${room.roomId} "${room.name}" at ${t.toISOString()}: ${String(roster.length)} member(s)`
    );
    if (!APPLY) continue;

    await prisma.$transaction(async (tx) => {
      await tx.groupClosureMember.deleteMany({
        where: { roomId: room.roomId },
      });
      if (roster.length) {
        await tx.groupClosureMember.createMany({
          data: roster.map((m) => {
            const u = byId.get(m.userId);
            return {
              roomId: room.roomId,
              userId: m.userId,
              username: u?.username ?? "",
              displayName: u?.displayName ?? "",
              avatar: u?.avatar ?? "",
              role: m.role,
              // Status AT closure: anyone ended afterwards was ACTIVE then.
              status: m.status === "BANNED" ? "BANNED" : "ACTIVE",
              joinedAt: m.joinedAt,
              bannedAt: m.bannedAt,
              closedAt: t,
            };
          }),
        });
      }
      await tx.groupRoom.update({
        where: { roomId: room.roomId },
        data: { memberCountAtClosure: roster.length },
      });
    });
    done++;
  }

  logger.info(
    `backfill(closure-snapshot): ${APPLY ? "wrote" : "would write"} ${String(
      APPLY ? done : rooms.length - unreconstructable.length
    )} room(s); ${String(unreconstructable.length)} unreconstructable${
      unreconstructable.length ? `: ${unreconstructable.join(", ")}` : ""
    }`
  );
}

main()
  .catch((err) => {
    logger.error(`backfill(closure-snapshot) failed: ${String(err)}`);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
