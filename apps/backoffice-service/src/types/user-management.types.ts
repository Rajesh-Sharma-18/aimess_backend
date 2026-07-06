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
  email: string;
  status: UserStatus;
  joinedAt: string;
  reportCount: number;
  /** Lifetime of `avatarUrl` in seconds; null when avatarUrl is null. */
  avatarUrlExpiresIn?: number | null;
  /**
   * Nested media descriptor for the avatar (additive, always present). Inner
   * fields are null when the avatar is unset / presign failed. Wraps the same
   * presigned GET the legacy `avatarUrl` carries via the shared media layer.
   */
  avatar: MediaObject;
  /** Derived from `status` — see {@link ModerationStatus}. Never replaces `status`. */
  moderationStatus: ModerationStatus;
  /** `true` iff the user is currently BANNED or SUSPENDED. Lets the panel pick
   * the Ban/Unban row action with no extra request. */
  isBanned: boolean;
  /** Present only when `isBanned` is true. */
  bannedAt?: string | null;
  /** Present only when `isBanned` is true — the acting admin's id (same concept
   * as the detail endpoint's `accountStatus.appliedBy`). */
  bannedBy?: string | null;
  /** Present only when `isBanned` is true. */
  banReason?: string | null;
};

/**
 * The repository's pre-resolution list row. Here `avatarUrl` carries the RAW
 * stored avatar value (object key from user-service), NOT a presigned URL — the
 * user-management service resolves it into the legacy presigned `avatarUrl`/
 * `avatarUrlExpiresIn` fields AND the nested `avatar: MediaObject` before the
 * row becomes a public {@link UserListItem}.
 */
export type UserListItemRaw = Omit<
  UserListItem,
  "avatarUrl" | "avatarUrlExpiresIn" | "avatar"
> & {
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
  expiresAt: string | null;
  createdAt: string;
};

/** One report-category count (ALL categories) shown on the detail view. */
export type ReportCategoryCount = {
  reason: string;
  count: number;
};

/** One row in the paginated "Reported Details" list for a user. */
export type ReportRow = {
  reportId: string;
  reason: string;
  details: string | null;
  status: string;
  createdAt: string;
  reporter: {
    userId: string;
    username: string | null;
    avatarKey: string | null;
  };
};

/** Aggregated reports filed against this user. */
export type ReportsSummary = {
  total: number;
  open: number;
  resolved: number;
  dismissed: number;
  topReasons: { reason: string; count: number }[];
};

/** Composed account-state block (from the UserIndex row). */
export type AccountStatusBlock = {
  status: UserStatus;
  since: string | null;
  reason: string | null;
  suspendedUntil: string | null;
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
    email: string;
    /** Presigned GET URL for the avatar, or null when unset / presign failed. */
    avatarUrl: string | null;
    /** Lifetime of `avatarUrl` in seconds; null when avatarUrl is null. */
    avatarUrlExpiresIn: number | null;
    /**
     * Nested media descriptor for the avatar (additive, always present). Inner
     * fields are null when the avatar is unset / presign failed. Wraps the same
     * presigned GET the legacy `avatarUrl` carries via the shared media layer.
     */
    avatar: MediaObject;
    joinedAt: string;
    lastActiveAt: string | null;
  };
  accountStatus: AccountStatusBlock;
  reportsSummary: ReportsSummary;
  // All report categories filed against this user (not just the top-5 in summary).
  reportCategories: ReportCategoryCount[];
  moderationHistory: ModerationHistoryItem[];
  stats: {
    reportCount: number;
  };
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
 * All timestamps are ISO strings ("" / null when absent). `status` is the
 * authoritative account status (auth-service is the source of truth under gRPC;
 * the Prisma mirror otherwise). `since`/`reason`/`suspendedUntil` already carry
 * the resolved account-state values so the service does not re-derive them.
 */
export type UserDirectoryRow = {
  userId: string;
  username: string;
  email: string;
  avatarUrl: string | null;
  status: UserStatus;
  joinedAt: string;
  lastActiveAt: string | null;
  /** When the current status took effect (bannedAt/suspendedAt/updatedAt). */
  since: string | null;
  /** Ban/suspend reason, or null. */
  reason: string | null;
  /** ISO suspension expiry, or null. */
  suspendedUntil: string | null;
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
};

/** Result of a single status mutation (echoed to the client). */
export type UserStatusResult = {
  userId: string;
  status: UserStatus;
  suspendedUntil: string | null;
  bannedAt: string | null;
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
