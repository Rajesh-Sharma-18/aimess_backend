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
  /** Resolved, client-viewable avatar URL of the requester — for the push tray/actorSnapshot. */
  requesterAvatarUrl?: string | null;
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
  /** Resolved avatar URL of the requester. */
  requesterAvatarUrl?: string | null;
  /** Resolved avatar URL of the addressee (accepter). */
  addresseeAvatarUrl?: string | null;
  acceptedAt: string;
};

export type FriendRejectedPayload = {
  friendshipId: string;
  requesterId: string;
  addresseeId: string;
  /** Display name of the addressee (rejecter) — the requester's "X declined your friend request" copy. */
  addresseeName?: string;
  /** Display name of the requester — the addressee's own "I have declined X" inbox copy. */
  requesterName?: string;
  /** Resolved avatar URL of the requester. */
  requesterAvatarUrl?: string | null;
  /** Resolved avatar URL of the addressee (rejecter). */
  addresseeAvatarUrl?: string | null;
  rejectedAt: string;
};

export type FriendCancelledPayload = {
  friendshipId: string;
  requesterId: string;
  addresseeId: string;
  /** Display name of the requester (canceller) — the addressee's "X cancelled their friend request" copy. */
  requesterName?: string;
  /** Resolved avatar URL of the requester (canceller). */
  requesterAvatarUrl?: string | null;
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
 * Realtime friend-request state for the chat clients: an incoming request
 * arriving, and that request being accepted/rejected. Delivered the SAME way as
 * `FriendSocketEvents` above (`user:<userId>` Redis relay → `/chat` namespace),
 * additive alongside them — not a replacement.
 *
 * A PENDING FRIEND REQUEST IS NOT A CONVERSATION. These events feed the Friend
 * Requests screen/section only. A client must NOT insert an inbox/conversation
 * row for a request — the conversation list comes exclusively from the inbox
 * REST/socket contract, which is backed by real rooms.
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

/**
 * @deprecated Do NOT render this as a conversation-list row — a pending friend
 * request is not a conversation and must not appear in the inbox. The shape is
 * retained only as the requester-profile carrier for
 * `conversation:pending-friend-request` (name/username/avatar for the Friend
 * Requests UI, so no follow-up fetch is needed). Kept on the wire for clients
 * that already read `conversation.requester`.
 */
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
