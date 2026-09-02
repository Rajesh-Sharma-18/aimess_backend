/** Cross-service user domain events (auth-service ↔ user-service). */
export const UserEvents = {
  USER_CREATED: "user.created",
  USER_DELETED: "user.deleted",
  /** Admin reactivation of a soft-deleted account — the exact inverse of USER_DELETED. */
  USER_RESTORED: "user.restored",
  /**
   * The grace period has elapsed and the account's personal data has been
   * ERASED in auth-service. Distinct from USER_DELETED, which is reversible and
   * changes no stored value: this one is terminal, and every service holding a
   * copy of that user's personal data must erase its own.
   */
  USER_PURGED: "user.purged",
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

/**
 * Published when an account's personal data has actually been erased.
 *
 * Deliberately carries NO personal data — not the old email, not the old
 * username. A purge event that echoed what it just erased would put that data
 * back into every consumer's log and dead-letter queue, which is where it is
 * hardest to find and remove later.
 *
 * Consumers replace their own copies of that user's identifying data
 * (denormalised name and avatar snapshots, profile fields, device tokens) and
 * keep the id, which the rest of the platform still references.
 */
export type UserPurgedPayload = {
  userId: string;
  purgedAt: string;
};

/**
 * Published by auth-service when a Super Admin reactivates a soft-deleted
 * account. Deletion never removed a row anywhere — it only set `deletedAt` +
 * `status` on the AuthUser and the UserProfile and let every read path project
 * an anonymized identity from those flags — so restoring is the exact inverse:
 * clear the flags, then let the normal `user.profile_updated` fanout push the
 * real identity back into every consumer that denormalized the placeholder.
 */
export type UserRestoredPayload = {
  userId: string;
  restoredAt: string;
  /** backoffice AdminUser.id of the Super Admin who reactivated. */
  actorAdminId?: string | null;
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
