import type { MediaObject } from "@aimess/shared-types";

/** A single accepted friend in the alphabetical friends list. */
export type FriendListItem = {
  userId: string;
  username: string;
  firstName: string;
  lastName: string;
  /** Presigned GET URL (private bucket); null if no avatar / MinIO unavailable. */
  avatarUrl: string | null;
  /**
   * Nested media object for the avatar. Inner fields are all null when no avatar
   * is set. Additive alongside the legacy `avatarUrl`.
   */
  avatar: MediaObject;
  /** Uppercased first letter of firstName, or "#" if non-alphabetic. */
  section: string;
};

export type FriendsListResult = {
  friends: FriendListItem[];
  nextCursor: string | null;
  /** Total number of accepted friends for the caller (not just this page). */
  totalCount: number;
};

export type FriendRequestDirection = "INCOMING" | "OUTGOING";

/** The other party in a pending friend request, with display fields. */
export type FriendRequestUser = {
  userId: string;
  username: string;
  firstName: string;
  lastName: string;
  /** Presigned GET URL (private bucket); null if no avatar / MinIO unavailable. */
  avatarUrl: string | null;
  avatar: MediaObject;
};

/** A single pending friend request returned by GET /friends/requests. */
export type FriendRequestItem = {
  friendshipId: string;
  /** INCOMING = they sent it to you; OUTGOING = you sent it to them. */
  direction: FriendRequestDirection;
  /** Always true for INCOMING, false for OUTGOING — mirrors buildFriendshipView. */
  canAccept: boolean;
  canReject: boolean;
  canCancel: boolean;
  user: FriendRequestUser;
  /** ISO-8601 timestamp of when the request was created. */
  createdAt: string;
};

export type FriendRequestsListResult = {
  requests: FriendRequestItem[];
  /** Total pending requests for the caller in the requested direction. */
  total: number;
};
