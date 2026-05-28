/** A single accepted friend in the alphabetical friends list. */
export type FriendListItem = {
  userId: string;
  username: string;
  firstName: string;
  lastName: string;
  /** Presigned GET URL (private bucket); null if no avatar / MinIO unavailable. */
  avatarUrl: string | null;
  /** Uppercased first letter of firstName, or "#" if non-alphabetic. */
  section: string;
};

export type FriendsListResult = {
  friends: FriendListItem[];
  nextCursor: string | null;
};
