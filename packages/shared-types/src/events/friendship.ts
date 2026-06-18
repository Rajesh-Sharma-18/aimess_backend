/** Cross-service friendship domain events (user-service → notifications-service). */
export const FriendshipEvents = {
  FRIEND_REQUESTED: "friend.requested",
  FRIEND_ACCEPTED: "friend.accepted",
  FRIEND_UNFRIENDED: "friend.unfriended",
} as const;

export type FriendshipEventType =
  (typeof FriendshipEvents)[keyof typeof FriendshipEvents];

export type FriendRequestedPayload = {
  friendshipId: string;
  requesterId: string;
  addresseeId: string;
  createdAt: string;
};

export type FriendAcceptedPayload = {
  friendshipId: string;
  requesterId: string;
  addresseeId: string;
  acceptedAt: string;
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
