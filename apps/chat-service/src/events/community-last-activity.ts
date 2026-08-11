import { logger } from "@aimess/logger";

import { normalizeMessageType } from "../lib/chat-message.serializer.js";
import { getCommunityReconcileClient } from "../grpc/community.client.js";
import { publishCommunityActivitySafe } from "./publish-community-activity.js";

/**
 * The SINGLE "persist the recalculated community lastActivity after a message
 * was removed" path, shared by the REST delete controller, the gRPC delete
 * handler and the pin-line retraction — which previously carried three copies of
 * the same block and the same bug.
 *
 * The bug: community-service's canonical bump (`updateLastActivity`) is
 * forward-only (`WHERE lastActivityAt < :at`), so it structurally cannot move the
 * pointer BACKWARD. A delete-for-everyone / auto-delete of the room's last
 * message needs exactly that — the activity must fall back to the PREVIOUS
 * visible message, whose `createdAt` is older. To get past the guard every call
 * site passed `Date.now()`, which wrote the DELETION's timestamp: the community
 * kept (or jumped to) the top of `GET /communities/mine` and rendered the
 * previous message's preview next to a just-now timestamp.
 *
 * Fix: send the previous message's REAL `createdAt` plus `rollbackNotNewerThan`
 * (the removed message's own `createdAt`), which puts community-service on its
 * backward path — guarded so anything that landed after the delete wins and the
 * rollback is skipped (the auto-delete-sweeper-vs-new-message race, §20).
 */
export interface DeleteRecalcActivity {
  prevMessageId: string | null;
  preview: string;
  messageType: string;
  sentBy: string;
  senderName: string;
  createdAt: Date;
  hasLastMessage: boolean;
  clientMessageId?: string | null;
  sequenceNumber?: number;
}

/**
 * @param removedAt the removed message's own `createdAt` — the rollback guard.
 *   Omitted by the pin-retraction path (the retracted system line was created
 *   moments ago), which falls back to "now" and therefore always rolls back.
 */
export async function reconcileCommunityLastActivityAfterDelete(params: {
  communityId: string;
  recalc: DeleteRecalcActivity;
  removedAt?: Date | null;
}): Promise<void> {
  const { communityId, recalc } = params;
  const rollbackNotNewerThan = (params.removedAt ?? new Date()).getTime();

  if (recalc.hasLastMessage) {
    // Async backstop. Carries the previous message's REAL timestamp, so under
    // community-service's forward-only guard it is a no-op in the normal case
    // and only ever repairs a column that has fallen BEHIND (a dropped earlier
    // activity event). It can no longer write a fabricated "now".
    publishCommunityActivitySafe({
      communityId,
      lastMessageAt: recalc.createdAt.toISOString(),
      lastMessageId: recalc.prevMessageId ?? "",
      senderUserId: recalc.sentBy,
      senderUsername: recalc.senderName,
      messagePreview: recalc.preview,
      type: "message",
      clientMessageId: recalc.clientMessageId ?? null,
      seq: recalc.sequenceNumber ?? 0,
      contentType: normalizeMessageType(recalc.messageType),
    });
  }

  // Synchronous companion — awaited by the caller before its response/ack, so a
  // client that re-fetches GET /communities/mine immediately can never race it.
  await getCommunityReconcileClient().updateMessageActivity({
    communityId,
    // 0 = the room is now empty; community-service falls back to the community's
    // own createdAt + the "created" activity type (its existing empty state).
    lastMessageAt: recalc.hasLastMessage ? recalc.createdAt.getTime() : 0,
    lastMessageId: recalc.hasLastMessage ? (recalc.prevMessageId ?? "") : "",
    senderUserId: recalc.hasLastMessage ? recalc.sentBy : "",
    senderUsername: recalc.hasLastMessage ? recalc.senderName : "",
    messagePreview: recalc.hasLastMessage ? recalc.preview : "",
    activityType: "message",
    clientMessageId: recalc.hasLastMessage
      ? (recalc.clientMessageId ?? null)
      : null,
    seq: recalc.hasLastMessage ? (recalc.sequenceNumber ?? 0) : 0,
    contentType: recalc.hasLastMessage
      ? normalizeMessageType(recalc.messageType)
      : "",
    rollbackNotNewerThan,
  });
}

/**
 * The `lastMessageAt` a realtime `community:updated` / `conv:updated` bump must
 * carry after a delete recalculation: the previous visible message's own
 * timestamp, or 0 when nothing visible remains. NEVER `Date.now()` — a client
 * that sorts its list on this field would otherwise pin an emptied room to the
 * top, which is the same defect as the persisted one above.
 */
export function bumpTimestampAfterDelete(recalc: {
  hasLastMessage: boolean;
  createdAt: Date;
}): number {
  return recalc.hasLastMessage ? recalc.createdAt.getTime() : 0;
}

/** Best-effort wrapper: reconciliation must never fail the delete itself. */
export async function reconcileCommunityLastActivityAfterDeleteSafe(params: {
  communityId: string;
  recalc: DeleteRecalcActivity;
  removedAt?: Date | null;
}): Promise<void> {
  try {
    await reconcileCommunityLastActivityAfterDelete(params);
  } catch (err) {
    logger.warn(
      `community lastActivity reconcile failed communityId=${params.communityId}: ${String(err)}`
    );
  }
}
