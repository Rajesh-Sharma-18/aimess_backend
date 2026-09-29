import { logger } from "@aimess/logger";
import type { UserPurgedPayload } from "@aimess/shared-types";

import { prisma } from "../config/prisma.js";

/**
 * Erase this service's copy of a purged user's personal data.
 *
 * chat-service consumed no user lifecycle event, so every message a deleted
 * account had ever sent kept a `senderName` and `senderAvatar` snapshot taken
 * at send time. Those are what the chat transcript and the conversation list
 * render — not a live lookup — so the person's real name and photo remained
 * visible in every conversation they had ever participated in, indefinitely,
 * after they deleted their account.
 *
 * The messages themselves stay. They are the other participants' conversation
 * history as much as the sender's, and deleting them would silently rewrite it.
 * What goes is the identity attached to them.
 *
 * Idempotent — a redelivered message writes the same placeholders.
 */
export async function handleUserPurged(data: UserPurgedPayload): Promise<void> {
  // Private, group and community-room messages each keep their own copy of the
  // snapshot, under slightly different column names.
  const [privateMessages, groupMessages, generalMessages, closureRows] =
    await Promise.all([
      prisma.privateMessage.updateMany({
        where: { senderId: data.userId },
        data: { senderName: "Deleted Account", senderAvatar: "" },
      }),
      prisma.groupMessage.updateMany({
        where: { senderId: data.userId },
        data: { senderName: "Deleted Account", senderAvatar: "" },
      }),
      prisma.generalRoomMessage.updateMany({
        where: { sentBy: data.userId },
        data: { senderName: "Deleted Account", senderAvatar: null },
      }),
      // Closed-group rosters keep the ROW (the group still had this member when
      // it closed, and its frozen count must not change) but lose the identity.
      prisma.groupClosureMember.updateMany({
        where: { userId: data.userId },
        data: { username: "", displayName: "Deleted Account", avatar: "" },
      }),
    ]);

  const total =
    privateMessages.count +
    groupMessages.count +
    generalMessages.count +
    closureRows.count;
  if (total > 0) {
    logger.info(
      `user.purged: erased sender identity on ${String(total)} message(s) for ${data.userId}`
    );
  }
}
