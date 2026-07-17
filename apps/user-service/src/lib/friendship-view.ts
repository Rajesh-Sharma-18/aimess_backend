/**
 * Derives a single, consistent "friendship view" from the viewer's
 * perspective, so every friendship-related API response (send/accept/reject/
 * cancel/unfriend/status) shapes the same object instead of each endpoint
 * inventing its own status/direction logic. The DB never stores direction —
 * only one `Friendship.status` per pair — the direction and the allowed
 * actions are always derived at read time from `requesterId`/`addresseeId`
 * relative to the viewer.
 */

export type FriendshipStatusView =
  | "NONE"
  | "PENDING"
  | "ACCEPTED"
  | "REJECTED"
  | "CANCELLED"
  | "UNFRIENDED"
  | "BLOCKED";

export type FriendshipDirection = "OUTGOING" | "INCOMING" | null;

export type FriendshipView = {
  status: FriendshipStatusView;
  direction: FriendshipDirection;
  canAccept: boolean;
  canReject: boolean;
  canCancel: boolean;
};

const NONE_VIEW: FriendshipView = {
  status: "NONE",
  direction: null,
  canAccept: false,
  canReject: false,
  canCancel: false,
};

const BLOCKED_VIEW: FriendshipView = {
  status: "BLOCKED",
  direction: null,
  canAccept: false,
  canReject: false,
  canCancel: false,
};

type FriendshipRowLike = {
  requesterId: string;
  addresseeId: string;
  status: string;
};

/**
 * `isBlockedByViewer` — true when the viewer has blocked the other party (or
 * vice versa). Block is modeled as a separate `Block` row, not a
 * `Friendship.status` value, but the response contract still surfaces it as
 * a `BLOCKED` status so the frontend never has to combine two API shapes.
 */
export function buildFriendshipView(
  viewerId: string,
  row: FriendshipRowLike | null,
  isBlockedByViewer = false
): FriendshipView {
  if (isBlockedByViewer) {
    return BLOCKED_VIEW;
  }

  if (!row) {
    return NONE_VIEW;
  }

  if (row.status === "ACCEPTED") {
    return {
      status: "ACCEPTED",
      direction: null,
      canAccept: false,
      canReject: false,
      canCancel: false,
    };
  }

  if (row.status !== "PENDING") {
    // REJECTED / CANCELLED / UNFRIENDED are terminal, historical rows — the
    // row is recycled on the next `sendRequest`, so from the viewer's
    // current-relationship perspective this is indistinguishable from NONE.
    return NONE_VIEW;
  }

  const direction: FriendshipDirection =
    row.requesterId === viewerId ? "OUTGOING" : "INCOMING";

  return {
    status: "PENDING",
    direction,
    canAccept: direction === "INCOMING",
    canReject: direction === "INCOMING",
    canCancel: direction === "OUTGOING",
  };
}

export type SearchRelationshipStatus = "FRIEND" | "PENDING" | "NONE";

export type SearchRelationship = {
  status: SearchRelationshipStatus;
  direction: FriendshipDirection;
  canAccept: boolean;
  canReject: boolean;
  canCancel: boolean;
};

/**
 * Maps a {@link FriendshipView} (ACCEPTED/BLOCKED/... vocabulary used by the
 * friend-request endpoints/events) to the User Search screen's normalized
 * `relationship` contract (FRIEND/PENDING/NONE). Reused by every `friend:*`
 * socket payload (see `friendshipEventData` in `friendship.service.ts`) so
 * the search screen can merge a live update without re-deriving direction or
 * action flags — the same shape `relationship-lookup.ts` builds for the
 * search REST response.
 */
export function toSearchRelationship(view: FriendshipView): SearchRelationship {
  return {
    status:
      view.status === "ACCEPTED"
        ? "FRIEND"
        : view.status === "PENDING"
          ? "PENDING"
          : "NONE",
    direction: view.direction,
    canAccept: view.canAccept,
    canReject: view.canReject,
    canCancel: view.canCancel,
  };
}

export type ChatRelationshipStatus = "FRIEND" | "PENDING" | "NONE" | "BLOCKED";

export type ChatRelationship = {
  status: ChatRelationshipStatus;
  direction: FriendshipDirection;
};

/**
 * Maps a {@link FriendshipView} to the private-chat cross-service contract
 * (`friendship: { status, direction }`, gRPC `FriendshipInfo`) — the one
 * vocabulary difference from {@link toSearchRelationship} is that BLOCKED is
 * preserved instead of collapsing to NONE, since chat-service needs it to
 * explain why sending is denied.
 */
export function toChatRelationship(view: FriendshipView): ChatRelationship {
  return {
    status:
      view.status === "ACCEPTED"
        ? "FRIEND"
        : view.status === "PENDING"
          ? "PENDING"
          : view.status === "BLOCKED"
            ? "BLOCKED"
            : "NONE",
    direction: view.direction,
  };
}
