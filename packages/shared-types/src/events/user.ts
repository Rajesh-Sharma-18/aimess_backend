/** Cross-service user domain events (auth-service ↔ user-service). */
export const UserEvents = {
  USER_CREATED: "user.created",
  USER_DELETED: "user.deleted",
  USER_PROFILE_UPDATED: "user.profile_updated",
} as const;

export type UserEventType = (typeof UserEvents)[keyof typeof UserEvents];

export type UserCreatedPayload = {
  userId: string;
  account: string;
  /** Present when the user registered or signed up with an email; omitted for account-only signup. */
  email?: string;
  createdAt: string;
  /** True when the user signed up via Google. */
  isGoogleLogin?: boolean;
};

export type UserDeletedPayload = {
  userId: string;
  deletedAt: string;
};

export type UserProfileUpdatedPayload = {
  userId: string;
  username: string;
  displayName: string;
  avatarObjectKey: string | null;
  /** True when all required profile fields are filled in (derived). */
  isProfileCompleted: boolean;
  updatedAt: string;
};
