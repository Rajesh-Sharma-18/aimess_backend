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
};
