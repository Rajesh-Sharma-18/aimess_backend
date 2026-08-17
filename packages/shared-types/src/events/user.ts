/** Cross-service user domain events (auth-service ↔ user-service). */
export const UserEvents = {
  USER_CREATED: "user.created",
  USER_DELETED: "user.deleted",
  USER_PROFILE_UPDATED: "user.profile_updated",
  /** Emitted when a user changes settings — lets notifications-service bust its
   *  cached notification-settings entry. */
  SETTINGS_UPDATED: "user.settings_updated",
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
  /**
   * Given name from the VERIFIED social provider profile (Google `given_name`,
   * Apple `givenName` from the first-authorization response). Omitted when the
   * provider gave nothing — the consumer must then keep its own fallback, never
   * write an empty string over a real name.
   */
  firstName?: string;
  /** Family name from the verified social provider profile. Same rule as {@link firstName}. */
  lastName?: string;
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
  /**
   * This "update" is an account DELETION, and the identity fields above are
   * already the anonymized representation (empty username, empty avatar,
   * displayName = the shared "Deleted Account" literal).
   *
   * Deletion rides this event rather than a parallel one because every existing
   * consumer already does exactly what deletion needs — chat-service drops the
   * cached user snapshot, community-service overwrites its denormalized member
   * snapshots and re-broadcasts the roster row. The flag is additive: a consumer
   * that ignores it still applies the anonymized values correctly, and one that
   * reads it can additionally emit the realtime "this account is gone" signal
   * that a rename must NOT produce.
   */
  isDeleted?: boolean;
};

export type UserSettingsUpdatedPayload = {
  userId: string;
  updatedAt: string;
};
