/**
 * One-off data-integrity fix, follow-up to `backfill-group-owner-to-admin.ts`.
 *
 * Under the OLD 4-tier role model (OWNER/ADMIN/MODERATOR/MEMBER), ADMIN was
 * NOT exclusive — a room could have one OWNER plus several ADMIN members at
 * once. The new model collapsed to 3 tiers (ADMIN/MODERATOR/MEMBER) with
 * EXACTLY ONE admin per group; `backfill-group-owner-to-admin.ts` only
 * converted the old OWNER row to ADMIN, so any room that already had a
 * second (non-owner) ADMIN now illegally has two.
 *
 * GroupMember has no `updatedAt`, so "which ADMIN row is current" can't be
 * read off the member row itself. The group's own SYSTEM message timeline
 * has the answer: every promotion-to-admin and admin hand-off already posts
 * a ROLE_CHANGED (newRole="ADMIN") or legacy OWNERSHIP_TRANSFERRED message,
 * in order, with a real `createdAt`. Walking that history backwards finds
 * the userId who most recently became the room's admin — the winner.
 * Falls back to GroupRoom.createdBy, then earliest joinedAt, only if no
 * such message exists (e.g. seed/test data with no chat history at all).
 *
 * Safe to re-run — idempotent, only acts on rooms that still have >1 ADMIN.
 *
 * Usage: pnpm --filter @aimess/chat-service db:backfill:single-group-admin
 */
import { prisma } from "../src/config/prisma.js";

async function findMostRecentAdmin(
  roomId: string,
  candidateUserIds: Set<string>
): Promise<string | null> {
  const events = await prisma.groupMessage.findMany({
    where: {
      roomId,
      systemEvent: { in: ["ROLE_CHANGED", "OWNERSHIP_TRANSFERRED"] },
    },
    orderBy: { createdAt: "desc" },
    select: { systemEvent: true, systemData: true },
    take: 200,
  });

  for (const e of events) {
    const data = (e.systemData ?? {}) as {
      targetUserId?: string;
      newRole?: string;
    };
    const becameAdmin =
      e.systemEvent === "OWNERSHIP_TRANSFERRED" || data.newRole === "ADMIN";
    if (
      becameAdmin &&
      data.targetUserId &&
      candidateUserIds.has(data.targetUserId)
    ) {
      return data.targetUserId;
    }
  }
  return null;
}

async function backfillSingleGroupAdmin() {
  const admins = await prisma.groupMember.findMany({
    where: { role: "ADMIN", status: "ACTIVE" },
    select: { id: true, roomId: true, userId: true, joinedAt: true },
  });

  const byRoom = new Map<string, typeof admins>();
  for (const a of admins) {
    const list = byRoom.get(a.roomId) ?? [];
    list.push(a);
    byRoom.set(a.roomId, list);
  }

  const multiAdminRooms = [...byRoom.entries()].filter(
    ([, list]) => list.length > 1
  );
  console.log(
    `Found ${multiAdminRooms.length} room(s) with more than one ADMIN.`
  );

  let demoted = 0;
  for (const [roomId, list] of multiAdminRooms) {
    const candidateIds = new Set(list.map((m) => m.userId));
    const fromHistory = await findMostRecentAdmin(roomId, candidateIds);

    let winner;
    let via;
    if (fromHistory) {
      winner = list.find((m) => m.userId === fromHistory)!;
      via = "most recent ROLE_CHANGED/OWNERSHIP_TRANSFERRED in chat history";
    } else {
      const room = await prisma.groupRoom.findUnique({
        where: { roomId },
        select: { createdBy: true },
      });
      const creatorRow = room
        ? list.find((m) => m.userId === room.createdBy)
        : undefined;
      winner =
        creatorRow ??
        [...list].sort(
          (a, b) => a.joinedAt.getTime() - b.joinedAt.getTime()
        )[0];
      via = creatorRow
        ? "room creator (no role-change history found)"
        : "earliest joinedAt (no role-change history, creator not among admins)";
    }

    const losers = list.filter((m) => m.id !== winner.id);
    await Promise.all(
      losers.map((m) =>
        prisma.groupMember.update({
          where: { id: m.id },
          data: { role: "MODERATOR" },
        })
      )
    );
    demoted += losers.length;

    console.log(
      `room=${roomId}: kept userId=${winner.userId} as ADMIN (${via}), ` +
        `demoted ${losers.length} to MODERATOR: ${losers.map((m) => m.userId).join(", ")}`
    );
  }

  console.log(`Done — demoted ${demoted} extra ADMIN row(s) to MODERATOR.`);
}

backfillSingleGroupAdmin()
  .catch((err) => {
    console.error("Backfill failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
