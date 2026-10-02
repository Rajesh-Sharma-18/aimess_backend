/**
 * Classify — and optionally HIDE — private rooms whose `participants` are not
 * two distinct user UUIDs.
 *
 * Origin. Invite shares (group: `POST /chat/invite-links/room/:roomId/
 * bulk-send`; community: `community.invite_link_shared`) take every selected
 * "recipient" as a user and get-or-create a PRIVATE room inviter↔recipient for
 * the invite card. A recipient that was a group room id (`grp_…`) or a
 * community id (24-hex ObjectId) produced a room with that id as the "peer",
 * then the invite card made it a real inbox row. Separately,
 * `POST /chat/private/rooms/:peerId` minted rooms for any string while the
 * friendship gate failed open. Both are closed now (`assertPrivateParticipants`
 * in the repository, the invite gate's local NOT_FOUND); this handles the rows
 * already written.
 *
 * Nothing is deleted. `--apply` only hides a SAFELY-REPAIRABLE room for its one
 * real participant — the same `deletedFor` stamp "Delete conversation" writes,
 * so every message, pin and attachment stays in the database and a later
 * decision can still delete or restore. A room is safely repairable only when
 * every message in it is an invite card (nobody's conversation). Anything else
 * is reported for manual review and left untouched. Empty rooms are already
 * outside every list; `purge:malformed-private-rooms` covers them.
 *
 * Idempotent: an already-hidden room with no newer message is skipped.
 *
 * Dry run (default, writes nothing):
 *   pnpm --filter @aimess/chat-service audit:malformed-private-rooms
 * Apply (hide safely-repairable rooms only):
 *   pnpm --filter @aimess/chat-service audit:malformed-private-rooms -- --apply
 */
import { logger } from "@aimess/logger";

import { prisma } from "../src/config/prisma.js";
import { isUserId, nonUserIdKind } from "../src/lib/room-id.js";
import { PrivateRoomRepository } from "../src/repositories/private-room.repository.js";

const APPLY = process.argv.includes("--apply");

type Classification =
  | "EMPTY"
  | "SAFELY_REPAIRABLE"
  | "ALREADY_REPAIRED"
  | "MISLABELED"
  | "MANUAL_REVIEW";

/** Invite cards carry a deterministic clientMessageId (`ginv:` group, `cinv:` community). */
function isInviteCard(m: {
  clientMessageId: string | null;
  systemEvent: string | null;
}): boolean {
  return (
    !!m.clientMessageId?.match(/^(ginv|cinv):/) ||
    m.systemEvent === "COMMUNITY_INVITE" ||
    m.systemEvent === "GROUP_INVITE"
  );
}

async function audit(): Promise<void> {
  // One projected scan, filtered in memory: "participants[i] is not a UUID"
  // is not an indexable query.
  const rooms = await prisma.privateRoom.findMany({
    select: {
      roomId: true,
      participants: true,
      participantsKey: true,
      lastMessageAt: true,
      lastMessageId: true,
      deletedFor: true,
      createdAt: true,
    },
  });
  const malformed = rooms.filter((r) => {
    const [a, b] = r.participants ?? [];
    return (
      (r.participants ?? []).length !== 2 ||
      !isUserId(a) ||
      !isUserId(b) ||
      a === b
    );
  });

  const kinds: Record<string, number> = {};
  const classes: Record<Classification, number> = {
    EMPTY: 0,
    SAFELY_REPAIRABLE: 0,
    ALREADY_REPAIRED: 0,
    MISLABELED: 0,
    MANUAL_REVIEW: 0,
  };
  const repo = new PrivateRoomRepository(prisma);
  let hidden = 0;

  for (const room of malformed) {
    const valid = room.participants.filter(isUserId);
    const invalid = room.participants.filter((p) => !isUserId(p));
    const invalidKinds = invalid.map(nonUserIdKind);
    for (const k of invalidKinds) kinds[k] = (kinds[k] ?? 0) + 1;

    // Does the bad id name a real conversation of another type?
    const [groupTargets, communityTargets] = await Promise.all([
      prisma.groupRoom.count({ where: { roomId: { in: invalid } } }),
      prisma.generalRoom.count({
        where: { id: { in: invalid.filter((i) => /^[0-9a-f]{24}$/i.test(i)) } },
      }),
    ]);
    // Mislabeled = this row IS a group/community room typed PRIVATE: its own
    // id is a group id, or it has community/general membership rows.
    const [ownGroup, roomMembers, pins] = await Promise.all([
      prisma.groupRoom.count({ where: { roomId: room.roomId } }),
      prisma.roomMember.count({ where: { roomId: room.roomId } }),
      prisma.privateMessagePin.count({ where: { roomId: room.roomId } }),
    ]);
    const messages = await prisma.privateMessage.findMany({
      where: { roomId: room.roomId },
      select: { senderId: true, clientMessageId: true, systemEvent: true },
    });
    const inviteCards = messages.filter(isInviteCard).length;
    const other = messages.length - inviteCards;
    const senders = [...new Set(messages.map((m) => m.senderId ?? "system"))];

    const viewer = valid.length === 1 ? valid[0]! : null;
    const deletedAt = viewer
      ? (room.deletedFor as Record<string, string> | null)?.[viewer]
      : undefined;
    const alreadyHidden =
      !!deletedAt &&
      (room.lastMessageAt?.getTime() ?? 0) <= new Date(deletedAt).getTime();

    let cls: Classification;
    if (room.roomId.startsWith("grp_") || ownGroup > 0 || roomMembers > 0) {
      cls = "MISLABELED";
    } else if (messages.length === 0 && !room.lastMessageAt) {
      cls = "EMPTY";
    } else if (
      viewer &&
      other === 0 &&
      senders.every((s) => s === viewer) &&
      room.participants.length === 2
    ) {
      cls = alreadyHidden ? "ALREADY_REPAIRED" : "SAFELY_REPAIRABLE";
    } else {
      cls = "MANUAL_REVIEW";
    }
    classes[cls] += 1;

    logger.info(
      `  ${room.roomId}  ${cls}  valid=${valid.length}  invalid=${invalid
        .map((id, i) => `${id}(${invalidKinds[i]})`)
        .join(",")}  targetExists=group:${groupTargets},community:${communityTargets}` +
        `  messages=${messages.length} (inviteCards=${inviteCards}, other=${other})  pins=${pins}` +
        `  roomMembers=${roomMembers}  senders=${senders.length}` +
        `  lastMessageAt=${room.lastMessageAt?.toISOString() ?? "null"}  created=${room.createdAt.toISOString()}`
    );

    if (APPLY && cls === "SAFELY_REPAIRABLE" && viewer) {
      await repo.setDeletedFor(room.roomId, viewer);
      hidden += 1;
      logger.info(`    hidden for its one real participant`);
    }
  }

  logger.info(
    [
      `audit(malformed-private-rooms)${APPLY ? "" : " — DRY RUN, pass --apply to hide safely-repairable rooms"}`,
      `Scanned private rooms: ${rooms.length}`,
      `Valid rooms: ${rooms.length - malformed.length}`,
      `Invalid rooms: ${malformed.length}`,
      `Invalid participant categories: ${
        Object.entries(kinds)
          .map(([k, n]) => `${k}=${n}`)
          .join(", ") || "none"
      }`,
      `Classification: ${Object.entries(classes)
        .map(([k, n]) => `${k}=${n}`)
        .join(", ")}`,
      APPLY ? `Hidden this run: ${hidden}` : "",
    ]
      .filter(Boolean)
      .join("\n")
  );
}

audit()
  .catch((err) => {
    logger.error(`audit(malformed-private-rooms) failed: ${String(err)}`);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
