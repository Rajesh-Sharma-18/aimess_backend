import { FriendshipEvents } from "@aimess/shared-types";

import {
  userGrpcClient,
  type FriendshipView,
} from "../grpc/user-snapshot.client.js";

const FRIENDSHIP_NOTIFICATION_TYPES = new Set<string>([
  FriendshipEvents.FRIEND_REQUESTED,
  FriendshipEvents.FRIEND_ACCEPTED,
]);

export interface NotificationFriendshipDTO extends FriendshipView {
  id: string;
}

/**
 * Resolves the *current* friendship state for a FRIEND_REQUEST(_ACCEPTED)
 * notification row, viewer-relative. Notification rows are immutable — the
 * friendship they reference can move on (accepted/rejected/cancelled/
 * blocked/unfriended) after the row was written, so the actionability flags
 * (canAccept/canReject/canCancel) must always be re-derived at read time
 * from the Friendship Service, never duplicated onto the Notification row.
 * Returns undefined for any other notification type or when friendshipId is
 * missing, so callers can spread it in only when present.
 */
export async function resolveNotificationFriendship(
  viewerId: string,
  type: string,
  friendshipId: string | undefined
): Promise<NotificationFriendshipDTO | undefined> {
  if (!friendshipId || !FRIENDSHIP_NOTIFICATION_TYPES.has(type)) {
    return undefined;
  }
  const view = await userGrpcClient.getFriendshipView(friendshipId, viewerId);
  if (!view) return undefined;
  return { id: friendshipId, ...view };
}
