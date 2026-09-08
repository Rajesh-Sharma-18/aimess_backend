/**
 * View-model types for the Admin User Management API (Phase 2, production).
 * Backed by the `UserIndex` read-model in admin_db merged with moderation
 * trail + report aggregates. Field names/casing are the stable JSON contract
 * the repository returns and the controllers serialize.
 *
 * Pagination shapes are reused verbatim from moderation.types.ts so list
 * endpoints stay envelope-compatible across modules.
 */
import type { MediaObject } from "@aimess/shared-types";

import type { Paginated, PaginationMeta } from "./moderation.types.js";

export type { Paginated, PaginationMeta };

/** Account status mirrored from auth-service (source of truth: AuthUser). */
export type UserStatus = "ACTIVE" | "SUSPENDED" | "BANNED" | "DELETED";

/**
 * Simplified 2-value moderation view derived from `status`, separate from the
 * full account-status taxonomy above (never replaces `status`). BANNED covers
 * BOTH a permanent ban and a time-boxed suspension — the platform restricts
 * the user in both cases, and this system has no auto-expiry that lapses a
 * SUSPENDED row back to ACTIVE on its own (an admin must explicitly unban).
 */
export type ModerationStatus = "ACTIVE" | "BANNED";

/** Reason taxonomy reused from the report reportType vocabulary (subset). */
export type ModerationReason =
  | "SPAM"
  | "HARASSMENT"
  | "HATE_SPEECH"
  | "NUDITY"
  | "VIOLENCE"
  | "IMPERSONATION"
  | "MISINFORMATION"
  | "ILLEGAL_CONTENT"
  | "OTHER";

/** A single row in the users table (list projection). */
export type UserListItem = {
  userId: string;
  username: string;
  /** firstName + lastName (trimmed, single-spaced); null when both are absent. */
  fullName: string | null;
  /** null when the user has no email on file (never an empty string). */
  email: string | null;
  status: UserStatus;
  joinedAt: number;
  reportCount: number;
  /**
   * Standard avatar object (see @aimess/shared-types MediaObject); null when
   * no avatar is set. Replaces the legacy bare avatarUrl string.
   */
  avatar: MediaObject | null;
  /** Derived from `status` — see {@link ModerationStatus}. Never replaces `status`. */
  moderationStatus: ModerationStatus;
  /** `true` iff the user is currently BANNED or SUSPENDED. Lets the panel pick
   * the Ban/Unban row action with no extra request. */
  isBanned: boolean;
  /** Present only when `isBanned` is true. */
  bannedAt?: number | null;
  /** Present only when `isBanned` is true — the acting admin's id (same concept
   * as the detail endpoint's `accountStatus.appliedBy`). */
  bannedBy?: string | null;
  /** Present only when `isBanned` is true. */
  banReason?: string | null;
};

/**
 * The repository's pre-resolution list row. Here `avatarUrl` carries the RAW
 * stored avatar value (object key from user-service), NOT a presigned URL — the
 * user-management service resolves it into the nested `avatar: MediaObject |
 * null` before the row becomes a public {@link UserListItem}.
 */
export type UserListItemRaw = Omit<UserListItem, "avatar"> & {
  /** Raw stored avatar value (object key), or null. */
  avatarUrl?: string | null;
};

/** One moderation-trail entry shown on the detail view. */
export type ModerationHistoryItem = {
  id: string;
  type: string;
  actorId: string;
  reason: string;
  note: string | null;
  reportId: string | null;
  expiresAt: number | null;
  createdAt: number;
};

/** One report-category count (ALL categories) shown on the detail view. */
export type ReportCategoryCount = {
  reason: string;
  count: number;
};

/** One free-text note filed under the custom "OTHER" reason. */
export type OtherReasonNote = {
  description: string;
  reportedBy: string | null;
  reportedAt: number;
};

/**
 * "Report Details" panel on the User Management detail screen. Single source
 * for report data on that screen — `reporter`/`reportDate` come from the most
 * recent report, `reportCount` is the total across every reason (predefined +
 * custom), `topReasons` is the predefined-reason breakdown (excludes
 * "OTHER"), and `otherReasons` carries the free-text notes filed under the
 * custom "OTHER" reason, each with its reporter and timestamp. Empty arrays
 * (never omitted) when the user has no reports.
 */
export type ReportDetailsBlock = {
  reporter: string | null;
  reportDate: number | null;
  reportCount: number;
  topReasons: ReportCategoryCount[];
  otherReasons: OtherReasonNote[];
};

/** One row in the paginated "Reported Details" list for a user. */
export type ReportRow = {
  reportId: string;
  reason: string;
  details: string | null;
  /** Custom description when `reason` is "OTHER"; null for every predefined reason. */
  otherReason: string | null;
  status: string;
  createdAt: number;
  /** Community the report was filed in; null for community-less reports. */
  communityId: string | null;
  /** Name of {@link communityId}'s community; null when absent/unresolved. */
  communityName: string | null;
  reporter: {
    userId: string;
    username: string | null;
    /** firstName + lastName (trimmed, single-spaced); null when both are absent. */
    fullname: string | null;
    avatarKey: string | null;
  };
};

/** Composed account-state block (from the UserIndex row). */
export type AccountStatusBlock = {
  status: UserStatus;
  since: number | null;
  reason: string | null;
  suspendedUntil: number | null;
  appliedBy: string | null;
  /** Derived from `status` — see {@link ModerationStatus}. Never replaces `status`. */
  moderationStatus: ModerationStatus;
  /** `true` iff the user is currently BANNED or SUSPENDED. */
  isBanned: boolean;
};

/** Full user detail returned by GET /users/{userId}. */
export type UserDetail = {
  profile: {
    userId: string;
    username: string;
    /** firstName + lastName (trimmed, single-spaced); null when both are absent. */
    fullName: string | null;
    /** null when the user has no email on file (never an empty string). */
    email: string | null;
    /**
     * Standard avatar object (see @aimess/shared-types MediaObject); null when
     * no avatar is set. The flat `avatarUrl`/`avatarUrlExpiresIn` legacy
     * fields are intentionally NOT part of this response — this is the only
     * avatar field the detail screen returns.
     */
    avatar: MediaObject | null;
    joinedAt: number;
    lastActiveAt: number | null;
  };
  accountStatus: AccountStatusBlock;
  reportDetails: ReportDetailsBlock;
};

/** The raw UserIndex row the repository returns for detail composition. */
export type UserIndexRow = {
  userId: string;
  username: string;
  email: string;
  status: UserStatus;
  reportCount: number;
  joinedAt: Date;
  lastActiveAt: Date | null;
  bannedAt: Date | null;
  banReason: string | null;
  suspendedUntil: Date | null;
  updatedAt: Date;
};

/**
 * Detail row returned by the directory repository for `getById`, normalized so
 * `userManagementService.getUser` can compose `profile` + `accountStatus`
 * regardless of whether the row came from the Prisma read-model or live gRPC.
 *
 * All timestamps are epoch-ms numbers (null when absent). `status` is the
 * authoritative account status (auth-service is the source of truth under gRPC;
 * the Prisma mirror otherwise). `since`/`reason`/`suspendedUntil` already carry
 * the resolved account-state values so the service does not re-derive them.
 */
export type UserDirectoryRow = {
  userId: string;
  username: string;
  /** firstName + lastName (trimmed, single-spaced); null when both are absent. */
  fullName: string | null;
  /** null when the user has no email on file (never an empty string). */
  email: string | null;
  avatarUrl: string | null;
  status: UserStatus;
  joinedAt: number;
  lastActiveAt: number | null;
  /** When the current status took effect (bannedAt/suspendedAt/updatedAt). */
  since: number | null;
  /** Ban/suspend reason, or null. */
  reason: string | null;
  /** epoch-ms suspension expiry, or null. */
  suspendedUntil: number | null;
};

/** Normalized list query (post-validation/coercion). */
export type ListUsersQuery = {
  search?: string;
  status?: UserStatus[];
  reports?: "none" | "has" | "gte_5" | "gte_10";
  dateFrom?: string;
  dateTo?: string;
  /** Canonical `<field>:<dir>` token consumed by the repository's orderBy. */
  sort: string;
  /**
   * Resolved UI-facing sort column (`username|email|joinedDate|reports|status`)
   * and direction. Derived from `sort` by the validator; consumed ONLY by the
   * list-view audit log — the repository sorts off `sort`, not these.
   */
  sortBy?: string;
  sortOrder?: "asc" | "desc";
  page: number;
  limit: number;
  cursor?: string;
};

// ---------------------------------------------------------------------------
// Mutation inputs forwarded by the service to repo.setStatus / bulkSetStatus.
// ---------------------------------------------------------------------------
export type StatusChange = {
  status: UserStatus;
  reason?: string | null;
  bannedAt?: Date | null;
  suspendedUntil?: Date | null;
  /**
   * When true and the target is `ACTIVE`, an already-ACTIVE user is treated as
   * an idempotent no-op (returned as a success, nothing written) instead of
   * raising `USER_NOT_BANNED`. Used by bulkActivate; the single /unban endpoint
   * leaves this unset and keeps its strict 409 behavior.
   */
  idempotentActive?: boolean;
  /**
   * Lifts the DELETED tombstone for this one write. DELETED normally rejects
   * every transition so a ban/suspend/unban can never touch a deleted account;
   * reactivation is the single legitimate DELETED → ACTIVE transition, and it
   * only ever runs AFTER auth-service has already restored the account.
   */
  fromDeleted?: boolean;
};

/** Result of a single status mutation (echoed to the client). */
export type UserStatusResult = {
  userId: string;
  status: UserStatus;
  suspendedUntil: number | null;
  bannedAt: number | null;
};

/** One entry in a bulk operation's result list. */
export type BulkResultItem =
  | {
      userId: string;
      status: UserStatus;
      ok: true;
      /**
       * Whether this item actually transitioned. `false` marks an idempotent
       * no-op (e.g. bulkActivate on an already-ACTIVE user): it counts as
       * succeeded but the service must NOT write audit/moderation rows or
       * publish an event for it. Optional → defaults to "changed" when absent.
       */
      changed?: boolean;
    }
  | {
      userId: string;
      ok: false;
      error: { code: string; message: string };
    };

/** Aggregate result of a bulk operation. */
export type BulkResult = {
  requested: number;
  succeeded: number;
  failed: number;
  results: BulkResultItem[];
};

// ---------------------------------------------------------------------------
// Linked devices (GET /v1/users/:userId/devices).
// ---------------------------------------------------------------------------

/**
 * One device linked to a user, as the admin panel renders it.
 *
 * Every optional attribute is `| null` rather than an empty string or a zero:
 * auth-service flattens nulls onto proto3 scalars, and this layer restores the
 * distinction so the UI can print "—" for "we don't know" instead of a made-up
 * 0 for a screen density or a `false` for a root check that never ran.
 *
 * Nothing here is a credential. There is no token, no FCM registration id and
 * no session secret — a device row is diagnostics, and the panel must not
 * become a place to read authentication material out of.
 */
export interface UserDeviceRow {
  deviceId: string;
  platform: string;
  deviceType: string | null;
  deviceName: string | null;
  manufacturer: string | null;
  brand: string | null;
  model: string | null;
  osVersion: string | null;
  sdkInt: number | null;
  appVersion: string | null;
  appBuild: number | null;
  buildType: string | null;
  installerPackage: string | null;
  locale: string | null;
  language: string | null;
  country: string | null;
  timezone: string | null;
  utcOffsetMinutes: number | null;
  screenWidthPx: number | null;
  screenHeightPx: number | null;
  screenDensityDpi: number | null;
  networkType: string | null;
  carrier: string | null;
  /** Client-asserted fraud signals. Spoofable — a flag is a prompt to look, not a verdict. */
  isEmulator: boolean | null;
  isRooted: boolean | null;
  /** Server-derived at login time; never supplied by the client. */
  ipAddress: string | null;
  countryCode: string | null;
  createdAt: number;
  updatedAt: number;
  lastSeenAt: number;
  lastLoginAt: number;
  /** Live sessions keyed on this device right now; 0 = signed out here. */
  activeSessionCount: number;
  isActive: boolean;
}

/** Query for GET /v1/users/:userId/devices. */
export interface ListUserDevicesQuery {
  page: number;
  limit: number;
}
