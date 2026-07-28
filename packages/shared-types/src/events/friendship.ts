/** Cross-service friendship domain events (user-service → notifications-service). */
export const FriendshipEvents = {
  FRIEND_REQUESTED: "friend.requested",
  FRIEND_ACCEPTED: "friend.accepted",
  FRIEND_REJECTED: "friend.rejected",
  FRIEND_CANCELLED: "friend.cancelled",
  FRIEND_UNFRIENDED: "friend.unfriended",
} as const;

export type FriendshipEventType =
  (typeof FriendshipEvents)[keyof typeof FriendshipEvents];

/**
 * Realtime Socket.IO event names for friendship state changes, delivered on
 * the `/chat` namespace via the existing `user:<userId>` Redis relay (see
 * `publishChatUserEvent` in `@aimess/redis`). Published by user-service after
 * every friendship-mutating DB write, to EVERY affected user's `user:<id>`
 * room — i.e. every logged-in device, regardless of whether the mutating
 * request came in over REST or a gateway socket RPC. Distinct from
 * `FriendshipEvents` above (RabbitMQ, push-notification concern).
 */
export const FriendSocketEvents = {
  REQUEST_SENT: "friend:request:sent",
  REQUEST_RECEIVED: "friend:request:received",
  ACCEPTED: "friend:accepted",
  REJECTED: "friend:rejected",
  REQUEST_CANCELLED: "friend:request:cancelled",
  REMOVED: "friend:removed",
  BLOCKED: "friend:blocked",
  UNBLOCKED: "friend:unblocked",
} as const;

export type FriendSocketEventType =
  (typeof FriendSocketEvents)[keyof typeof FriendSocketEvents];

export type FriendRequestedPayload = {
  friendshipId: string;
  requesterId: string;
  addresseeId: string;
  /** Display name of the requester — lets the addressee's push/inbox copy say "X sent you a friend request." */
  requesterName?: string;
  createdAt: string;
};

export type FriendAcceptedPayload = {
  friendshipId: string;
  requesterId: string;
  addresseeId: string;
  /** Display name of the requester — the addressee's own "You are now friends with X" copy. */
  requesterName?: string;
  /** Display name of the addressee (accepter) — the requester's "X accepted your friend request" copy. */
  addresseeName?: string;
  acceptedAt: string;
};

export type FriendRejectedPayload = {
  friendshipId: string;
  requesterId: string;
  addresseeId: string;
  /** Display name of the addressee (rejecter) — the requester's "X declined your friend request" copy. */
  addresseeName?: string;
  rejectedAt: string;
};

export type FriendCancelledPayload = {
  friendshipId: string;
  requesterId: string;
  addresseeId: string;
  /** Display name of the requester (canceller) — the addressee's "X cancelled their friend request" copy. */
  requesterName?: string;
  cancelledAt: string;
};

export type FriendUnfriendedPayload = {
  friendshipId: string;
  unfriendedById: string;
  otherUserId: string;
  unfriendedAt: string;
};

/**
 * Relationship read-model events (user-service → chat-service) published to the
 * `user.events` TOPIC exchange (routing key == the `type` string). They populate
 * chat-service's local friendship read-model that gates private 1-1 rooms.
 * Distinct from the notification-oriented FriendshipEvents above, which flow to
 * notifications-service over the `friendship.queue`.
 */
export const USER_EVENTS_EXCHANGE = "user.events";

export const FriendshipReadModelEvents = {
  FRIENDSHIP_CREATED: "friendship.created",
  FRIENDSHIP_DELETED: "friendship.deleted",
  FRIENDSHIP_BLOCKED: "friendship.blocked",
  FRIENDSHIP_BANNED: "friendship.banned",
} as const;

export type FriendshipReadModelEventType =
  (typeof FriendshipReadModelEvents)[keyof typeof FriendshipReadModelEvents];

export type FriendshipReadModelPayload = {
  type: FriendshipReadModelEventType;
  userA: string;
  userB: string;
  status?: string;
  timestamp: number;
};

/**
 * Realtime events for the "pending friend-request conversation row" feature —
 * lets a private-chat conversation list show an incoming friend request as a
 * pending entry (Telegram-style) before any room/message exists, and update
 * live when it's accepted/rejected. Delivered the SAME way as
 * `FriendSocketEvents` above (`user:<userId>` Redis relay → `/chat` namespace),
 * additive alongside them — not a replacement.
 */
export const ConversationSocketEvents = {
  PENDING_FRIEND_REQUEST: "conversation:pending-friend-request",
  FRIEND_REQUEST_ACCEPTED: "conversation:friend-request-accepted",
  FRIEND_REQUEST_REJECTED: "conversation:friend-request-rejected",
} as const;

export type ConversationSocketEventType =
  (typeof ConversationSocketEvents)[keyof typeof ConversationSocketEvents];

export type ConversationRequesterBrief = {
  id: string;
  displayName: string;
  username: string;
  avatarUrl: string | null;
};

/** Synthetic conversation-list row for an incoming pending friend request — never backed by a real chat room. */
export type PendingFriendRequestConversation = {
  id: string; // `pending:<friendshipId>` — never a real roomId
  type: "PRIVATE_PENDING";
  pendingRequest: true;
  friendRequestId: string;
  requester: ConversationRequesterBrief;
  createdAt: string;
  updatedAt: string;
  lastActivity: { type: "FRIEND_REQUEST"; text: "Friend Request" };
};

/** `conversation:pending-friend-request` — delivered ONLY to the addressee (target user). */
export type ConversationPendingFriendRequestPayload = {
  conversation: PendingFriendRequestConversation;
  friendRequest: {
    id: string;
    requesterId: string;
    addresseeId: string;
    status: "PENDING";
    createdAt: string;
  };
};

/**
 * `conversation:friend-request-accepted` — delivered to both parties so every
 * open device drops its pending row; `roomId` is null only if eager room
 * creation failed (rare — the room still lazily creates on first open).
 */
export type ConversationFriendRequestAcceptedPayload = {
  friendRequest: {
    id: string;
    requesterId: string;
    addresseeId: string;
    status: "ACCEPTED";
    acceptedAt: string;
  };
  roomId: string | null;
  peerId: string;
};

/**
 * `conversation:friend-request-rejected` — delivered to both parties so every
 * open device drops the pending row. Fired on an explicit reject (by the
 * addressee) OR a cancel (by the requester, before the addressee responds).
 */
export type ConversationFriendRequestRejectedPayload = {
  friendRequest: {
    id: string;
    requesterId: string;
    addresseeId: string;
    status: "REJECTED" | "CANCELLED";
    rejectedAt: string;
  };
  peerId: string;
};
