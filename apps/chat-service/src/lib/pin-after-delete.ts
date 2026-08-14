import { logger } from "@aimess/logger";

import type { Redis, Cluster } from "ioredis";

/**
 * The two pin-service methods the delete hook needs. Private, Group and
 * Community all implement this identically, so the four delete entry points
 * (REST private/group/community, the socket/gRPC orchestrator, and the gRPC
 * community handler) share ONE hook instead of four near-copies that drifted.
 */
export interface DeleteAwarePinService {
  unpinDeletedMessage(
    messageId: string,
    actorId: string
  ): Promise<{ roomId: string; pinnedCount: number } | null>;
  findActivePinRoomId(messageId: string): Promise<string | null>;
}

export interface UnpinAfterDeleteParams {
  redis: Redis | Cluster;
  pinService: DeleteAwarePinService;
  /** DIRECT = private/group (`pin:updated` on /chat); COMMUNITY = /community. */
  kind: "DIRECT" | "COMMUNITY";
  roomId: string;
  messageId: string;
  /** The deleting user — the actor recorded on the unpin, and the ONLY
   *  recipient on a delete-for-me. */
  userId: string;
  scope: "forMe" | "forEveryone";
  /** COMMUNITY only — the broadcast channel key (Community.id). */
  communityId?: string;
}

/**
 * Keep pin state consistent with a message that was just deleted.
 *
 * forEveryone — the message is gone for everybody, so the pin must be gone for
 *   everybody: the pin row is soft-deleted (not merely flagged "unavailable",
 *   which left a dead banner pinned for every member) and the removal is
 *   broadcast to the whole room.
 * forMe — the message is hidden for ONE user, so the pin is removed for that
 *   user ONLY: the pin row is untouched (every other user keeps seeing it) and
 *   the removal is published to that user's own `user:<id>` channel, which
 *   reaches all of their devices and nobody else's. The durable half is a
 *   read-time filter (`isHiddenForUser` in the pin services), so a reconnect or
 *   a cold load resolves to the same state without any per-user pin row.
 *
 * Best-effort by design: a pin-hook failure must never fail the delete itself,
 * which is already committed by the time this runs.
 */
export async function unpinAfterDelete(
  params: UnpinAfterDeleteParams
): Promise<void> {
  const { redis, pinService, kind, roomId, messageId, userId, scope } = params;
  const communityId = params.communityId || roomId;

  try {
    if (scope === "forEveryone") {
      const removed = await pinService.unpinDeletedMessage(messageId, userId);
      // Already unpinned (or never pinned) — nothing to announce.
      if (!removed) return;
      const channel =
        kind === "COMMUNITY" ? `community:${communityId}` : `conv:${roomId}`;
      await redis.publish(
        channel,
        JSON.stringify(
          kind === "COMMUNITY"
            ? {
                event: "community:message:unpinned",
                data: {
                  roomId,
                  communityId,
                  messageId,
                  unpinnedBy: userId,
                  pinnedCount: removed.pinnedCount,
                },
              }
            : {
                event: "pin:updated",
                data: {
                  roomId,
                  conversationId: roomId,
                  messageId,
                  unpinnedBy: userId,
                  action: "unpinned",
                  pinnedCount: removed.pinnedCount,
                },
              }
        )
      );
      return;
    }

    // forMe: only worth an event when this message is what's currently pinned.
    const pinnedRoomId = await pinService.findActivePinRoomId(messageId);
    if (!pinnedRoomId || (roomId && pinnedRoomId !== roomId)) return;
    await redis.publish(
      `user:${userId}`,
      JSON.stringify(
        kind === "COMMUNITY"
          ? {
              event: "community:message:unpinned",
              data: {
                roomId,
                communityId,
                messageId,
                unpinnedBy: userId,
              },
            }
          : {
              event: "pin:updated",
              data: {
                roomId,
                conversationId: roomId,
                messageId,
                unpinnedBy: userId,
                action: "unpinned",
              },
            }
      )
    );
  } catch (err) {
    logger.warn(
      `unpinAfterDelete failed scope=${scope} roomId=${roomId} messageId=${messageId}: ${String(err)}`
    );
  }
}
