export interface UserSnapshot {
  userId: string;
  username: string;
  displayName: string;
  firstName: string;
  lastName: string;
  avatarObjectKey: string;
  avatarUrl: string;
  isDeleted: boolean;
  isSuspended: boolean;
}

/** Identity shown on the login password step. Same avatar pair as profile responses. */
export interface LoginAccountPreview {
  displayName: string;
  firstName: string;
  lastName: string;
  username: string;
  avatarUrl: string | null;
  avatarObjectKey: string | null;
}

export function toLoginAccountPreview(
  user: UserSnapshot | undefined
): LoginAccountPreview | null {
  if (!user || user.isDeleted || user.isSuspended) return null;
  return {
    displayName: user.displayName,
    firstName: user.firstName,
    lastName: user.lastName,
    username: user.username,
    avatarUrl: user.avatarUrl || null,
    avatarObjectKey: user.avatarObjectKey || null,
  };
}
