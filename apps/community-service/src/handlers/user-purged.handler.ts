import { logger } from "@aimess/logger";
import type { UserPurgedPayload } from "@aimess/shared-types";

import { prisma } from "../config/prisma.js";

/**
 * Erase this service's copy of a purged user's personal data.
 *
 * community-service consumed no user lifecycle event at all, so a deleted
 * account's name and avatar stayed on every `CommunityMember` row it had
 * — denormalised snapshots taken at join time and rendered directly in member
 * lists, so the person's real name kept appearing across the platform after
 * they deleted their account.
 *
 * Membership rows survive: they carry role, join time and moderation history
 * that the community still needs, and their `userId` is referenced elsewhere.
 * The snapshot columns are what has to go.
 *
 * Idempotent — a redelivered message writes the same placeholders.
 */
export async function handleUserPurged(data: UserPurgedPayload): Promise<void> {
  const members = await prisma.communityMember.updateMany({
    where: { userId: data.userId },
    data: {
      snapshotUsername: "deleted",
      snapshotDisplayName: "Deleted Account",
      // Not merely blanked: the key addresses an object in the avatar bucket,
      // and a null tells every read path to fall back to the default avatar
      // rather than sign a URL for a photo of a person who deleted it.
      snapshotAvatarKey: null,
    },
  });

  if (members.count > 0) {
    logger.info(
      `user.purged: erased ${String(members.count)} community member snapshot(s) for ${data.userId}`
    );
  }
}
