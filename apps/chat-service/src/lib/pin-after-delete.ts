import { logger } from "@aimess/logger";

import type { Redis, Cluster } from "ioredis";

import { buildDeletePayload } from "./chat-message.serializer.js";

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
  /**
   * Delete-for-me counterpart of the GLOBAL system-line retraction that unpin
   * and delete-for-everyone already do: hides this pin's "<actor> pinned a
   * message" line for ONE user. Optional so the existing test doubles that
   * only implement the two methods above keep type-checking.
   */
  hidePinSystemMessageForUser?(
    messageId: string,
    userId: string
  ): Promise<{
    messageId: string;
    roomId: string;
    sequenceNumber: number;
  } | null>;
}

export interface UnpinAfterDeleteResult {
  /**
   * `sequenceNumber` of the pin system line this hook hid for the deleting
   * user (delete-for-me only), or 0 when it hid nothing. Callers fold it into
   * the sequence they hand `recalculateLastMessageAfterDeleteForMe`: the line
   * is usually NEWER than the deleted message, so the "was this the viewer's
   * last visible row?" decision has to be made on the newest row that was
   * removed, not just on the message the user tapped.
   */
  hiddenSystemLineSeq: number;
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
  /** DIRECT only — which tombstone shape the per-user system-line hide emits
   *  (GROUP carries `deletedType`, PRIVATE does not). Defaults to PRIVATE. */
  directType?: "PRIVATE" | "GROUP";
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
 *   The pin's "<actor> pinned a message" SYSTEM line goes with it, hidden for
 *   that one user (`hidePinSystemMessageForUser`) — the per-user twin of the
 *   global retraction the two paths above perform. Otherwise a viewer who
 *   deleted the pinned message kept a line announcing a pin they can no longer
 *   see, and — because a PINNED_MESSAGE line bumps activity — an inbox row
 *   previewing it forever. The hidden line's `sequenceNumber` is returned so
 *   the caller's lastActivity recalculation decides on the NEWEST row that was
 *   removed, not just on the message the user tapped.
 *
 * Best-effort by design: a pin-hook failure must never fail the delete itself,
 * which is already committed by the time this runs.
 */
export async function unpinAfterDelete(
  params: UnpinAfterDeleteParams
): Promise<UnpinAfterDeleteResult> {
  const { redis, pinService, kind, roomId, messageId, userId, scope } = params;
  const communityId = params.communityId || roomId;

  try {
    if (scope === "forEveryone") {
      const removed = await pinService.unpinDeletedMessage(messageId, userId);
      // Already unpinned (or never pinned) — nothing to announce.
      if (!removed) return { hiddenSystemLineSeq: 0 };
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
      return { hiddenSystemLineSeq: 0 };
    }

    // forMe: only worth an event when this message is what's currently pinned.
    const pinnedRoomId = await pinService.findActivePinRoomId(messageId);
    if (!pinnedRoomId || (roomId && pinnedRoomId !== roomId))
      return { hiddenSystemLineSeq: 0 };
    // The pin is gone for this viewer, so its "<actor> pinned a message"
    // system line must go with it — for this viewer ONLY (per-user hide, the
    // pin row and every other member's copy of the line are untouched). This
    // is the per-user twin of the global retraction unpin/forEveryone run.
    // Hidden BEFORE the caller's lastActivity recalculation (every delete
    // entry point awaits this hook first), so the recalc skips the line
    // instead of pinning the list preview to it forever.
    const hiddenSystemLine = await pinService.hidePinSystemMessageForUser?.(
      messageId,
      userId
    );
    if (hiddenSystemLine) {
      await redis.publish(
        `user:${userId}`,
        JSON.stringify({
          event:
            kind === "COMMUNITY"
              ? "community:message:deleted"
              : "message:delete",
          data: buildDeletePayload({
            conversationType:
              kind === "COMMUNITY"
                ? "COMMUNITY"
                : (params.directType ?? "PRIVATE"),
            messageId: hiddenSystemLine.messageId,
            roomId: hiddenSystemLine.roomId,
            scope: "forMe",
            deletedBy: userId,
            sequenceNumber: hiddenSystemLine.sequenceNumber,
            deletedAt: Date.now(),
            ...(kind === "COMMUNITY" ? {} : { deletedType: "SELF_DELETE" }),
          }),
        })
      );
    }
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
    return { hiddenSystemLineSeq: hiddenSystemLine?.sequenceNumber ?? 0 };
  } catch (err) {
    logger.warn(
      `unpinAfterDelete failed scope=${scope} roomId=${roomId} messageId=${messageId}: ${String(err)}`
    );
    return { hiddenSystemLineSeq: 0 };
  }
}
