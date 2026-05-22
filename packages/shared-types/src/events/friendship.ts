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
