/**
 * View-model types for the Community Management admin API.
 * These mirror the JSON contract agreed with the frontend (field names + casing).
 * They are the shapes the repository returns and the controllers serialize —
 * stable across Phase 1 (mock fixtures) and Phase 2 (gRPC → community/stream/user).
 */

import type { MediaObject } from "@aimess/shared-types";

import type { PaginationMeta, Paginated } from "./moderation.types.js";

// Re-export the shared pagination shapes so the community module reads them
// from its own type file (the frontend pager needs total / totalPages).
export type { PaginationMeta, Paginated };

export type CommunityType = "PUBLIC" | "PRIVATE";

/** Admin moderation state ("Closed" in the UI == repo CLOSED == service SUSPENDED). */
export type CommunityModerationStatus = "ACTIVE" | "CLOSED";

export type CloseReasonCode =
  | "GUIDELINES_VIOLATION"
  | "SPAM"
  | "ILLEGAL_CONTENT"
  | "INACTIVE"
  | "ADMIN_ACTION";

/** Account standing of the community owner (mirrors the reports module). */
export type AccountStatus = "ACTIVE" | "SUSPENDED" | "BANNED" | "DELETED";

/** Compact category reference shown in the list + detail. */
export type CategoryRef = {
  id: string;
  name: string;
  slug: string;
};

/** Compact admin/owner reference shown in the list table. */
export type CommunityAdminRef = {
  userId: string;
  name: string;
  // Standard avatar object (see @aimess/shared-types MediaObject) — matches
  // the shape used across User APIs / Community Details. Replaces the legacy
  // bare avatarUrl string; null when no avatar is set.
  avatar: MediaObject | null;
};

/** Livestream counter projected onto the list ("x/5" in the UI). */
export type LivestreamCounter = {
  value: number;
  max: number;
  /** Phase 1 fixtures are not live data — always stale until stream-service gRPC. */
  stale: boolean;
};

/** Row-level capability flags driving the action menu in the table. */
export type CommunityActions = {
  canView: boolean;
  canClose: boolean;
  canReopen: boolean;
};

/** A single row in the communities table (list projection). */
export type CommunityListItem = {
  communityId: string;
  communityName: string;
  /** Community's own avatar/profile image (project-standard MediaObject); null when unset. */
  avatar: MediaObject | null;
  admin: CommunityAdminRef;
  type: CommunityType;
  category: CategoryRef;
  status: CommunityModerationStatus;
  /**
   * "ADMIN_BANNED" when this community was closed because its owner was banned.
   * `status` above is the platform-moderation axis and stays ACTIVE for that
   * kind of close, so the list needs this to render it as closed at all.
   */
  closedReasonCode: string | null;
  memberCount: number;
  livestreamCount: LivestreamCounter;
  createdAt: number;
  actions: CommunityActions;
};

/** Full owner profile with moderation signals (detail view). */
export type CommunityOwner = {
  userId: string;
  displayName: string;
  username: string;
  // Standard avatar object (see @aimess/shared-types MediaObject); null when
  // the owner has no avatar. Replaces the legacy bare avatarUrl string.
  avatar: MediaObject | null;
  email: string | null;
  accountStatus: AccountStatus;
};

/** Aggregated membership stats (detail view). */
export type CommunityMemberStats = {
  total: number;
  active: number;
  pending: number;
  banned: number;
  moderators: number;
  joinedLast7d: number;
};

/** Aggregated livestream stats (detail view). null when stream-service has no data. */
export type CommunityLivestreamStats = {
  total: number;
  live: number;
  scheduled: number;
  maxConcurrent: number;
  /** Phase 1 fixtures are not live data — always stale until stream-service gRPC. */
  stale: true;
};

/** Actor stamp on a moderation-history entry. */
export type ModerationActor = {
  adminId: string;
  name: string;
};

/** One entry in the community's moderation timeline (detail view). */
export type CommunityModerationHistoryItem = {
  id: string;
  type: string;
  reason: string;
  actor: ModerationActor;
  createdAt: number;
  metadata: Record<string, unknown>;
};

/** Quick settings snapshot shown on the detail header. */
export type CommunitySettingsSummary = {
  joinPolicy: string;
  type: CommunityType;
  memberCount: number;
  inviteLinksActive: number;
  openReports: number;
  createdAt: number;
};

/** Core community block of the detail payload. */
export type CommunityCore = {
  communityId: string;
  name: string;
  handle: string;
  description: string | null;
  type: CommunityType;
  category: CategoryRef;
  status: CommunityModerationStatus;
  // Standard avatar object (see @aimess/shared-types MediaObject); null when
  // the community has no avatar. Replaces the legacy bare avatarUrl string.
  avatar: MediaObject | null;
  coverUrl: string | null;
  createdAt: number;
  lastActivityAt: number;
  // "ADMIN_BANNED" when the community was closed because its owner was
  // permanently system-banned; null otherwise. Never derive this from the
  // owner's CURRENT account status — an unban flips that back to ACTIVE while
  // the community stays closed forever.
  closedReasonCode: string | null;
};

/**
 * The full community detail composed by the repository layer. This is the
 * internal domain shape — it also backs the list projection (`toListItem`
 * reads `settingsSummary.memberCount` / `livestreamStats`) and the Mock
 * repository's close/reopen history mutations. NOT the wire response for
 * GET /communities/{communityId} — see {@link CommunityDetailResponse}.
 */
export type CommunityDetail = {
  community: CommunityCore;
  owner: CommunityOwner;
  memberStats: CommunityMemberStats;
  livestreamStats: CommunityLivestreamStats | null;
  moderationHistory: CommunityModerationHistoryItem[];
  settingsSummary: CommunitySettingsSummary;
  /** True when one or more upstream sources (stream/user) could not be reached. */
  partial: boolean;
};

/**
 * The wire response for GET /communities/{communityId}. Fully flat — reshaped
 * from {@link CommunityDetail} at the API boundary: `community`/`owner`
 * sub-objects are inlined onto the root (no nested wrappers), `memberStats`/
 * `livestreamStats` collapse to single numbers (`membersCount`/
 * `liveStreamsCount`), and `moderationHistory`/`settingsSummary`/`partial`
 * are dropped entirely.
 */
export type CommunityDetailResponse = {
  communityId: string;
  communityName: string;
  communityHandle: string;
  communityAvatar: MediaObject | null;
  communityType: CommunityType;
  category: CategoryRef;
  status: CommunityModerationStatus;
  createdAt: number;
  description: string | null;
  coverUrl: string | null;
  lastActivityAt: number;
  ownerId: string;
  ownerName: string;
  ownerUsername: string;
  ownerAvatar: MediaObject | null;
  ownerEmail: string | null;
  ownerAccountStatus: AccountStatus;
  /** "ADMIN_BANNED" when closed because the owner was system-banned. */
  closedReasonCode: string | null;
  /** Current total community members (`memberStats.total`). */
  membersCount: number;
  /** Currently-active (LIVE) livestreams for this community. */
  liveStreamsCount: number;
};

// ---------------------------------------------------------------------------
// Decision inputs + results.
// ---------------------------------------------------------------------------

/** Close payload the service forwards from the validated body. */
export type CloseInput = {
  reasonCode: CloseReasonCode;
  reasonNote?: string;
  notifyOwner?: boolean;
};

/** Reopen payload the service forwards from the validated body. */
export type ReopenInput = {
  reasonNote?: string;
  notifyOwner?: boolean;
};

/** Result of a close action (audit/moderation ids attached by the service). */
export type CloseResult = {
  communityId: string;
  status: CommunityModerationStatus;
  closedAt: number;
  reasonCode: CloseReasonCode;
  moderationActionId: string;
  auditLogId: string;
};

/** Result of a reopen action (audit/moderation ids attached by the service). */
export type ReopenResult = {
  communityId: string;
  status: CommunityModerationStatus;
  reopenedAt: number;
  moderationActionId: string;
  auditLogId: string;
};

/** Kick/ban-member payload the service forwards from the validated body. */
export type MemberModerationInput = {
  reason?: string;
};

/** Community Conversation viewer — paginated message read query. */
export type ConversationMessagesQuery = {
  cursor?: string;
  limit: number;
};

/** One message row in the Community Conversation viewer. */
export type ConversationMessageItem = {
  messageId: string;
  senderId: string;
  senderName: string;
  senderAvatar: string | null;
  message: string;
  contentType: string;
  attachments: unknown[];
  reactions: unknown[];
  quoteData: unknown | null;
  sentAt: number;
  systemMessageType: string | null;
};

/** Community Conversation viewer — paginated message read result. */
export type ConversationMessagesResult = {
  messages: ConversationMessageItem[];
  nextCursor: string | null;
  hasMore: boolean;
  pinnedMessage: unknown | null;
};

/** Result of a kick/ban-member action (audit/moderation ids attached by the service). */
export type MemberModerationResult = {
  communityId: string;
  targetUserId: string;
  status: string;
  moderationActionId: string;
  auditLogId: string;
};

/** One entry in a bulk operation's result list. */
export type BulkResultItem =
  | { communityId: string; status: CommunityModerationStatus; ok: true }
  | {
      communityId: string;
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
// Community Member List (the "Community User List" grid on the User Management
// detail screen). Read-through from community-service over gRPC.
// ---------------------------------------------------------------------------

/** Member role within a community. */
export type CommunityMemberRole = "ADMIN" | "MODERATOR" | "MEMBER";

/** Member lifecycle status within a community. */
export type CommunityMemberStatus = "ACTIVE" | "PENDING" | "BANNED" | "LEFT";

/** A single row in the community members grid. */
export type CommunityMemberRow = {
  userId: string;
  /** Display name (falls back to the @handle when no display name). */
  username: string;
  /** The @handle (snapshot username). */
  handle: string;
  // Standard avatar object (see @aimess/shared-types MediaObject); null when
  // the member has no avatar. Replaces the legacy bare avatarUrl string.
  avatar: MediaObject | null;
  role: CommunityMemberRole;
  status: CommunityMemberStatus;
  // Account status from the backoffice UserIndex mirror: ACTIVE | BANNED |
  // SUSPENDED. Lets the panel hide the ban action for a SYSTEM-banned user.
  accountStatus: string;
  joinedAt: number;
};

/** Normalized member-list query (post-validation/coercion). */
export type ListCommunityMembersQuery = {
  search?: string;
  role?: CommunityMemberRole;
  page: number;
  limit: number;
  /**
   * userId excluded at the DB level (community-service) — used to hide the
   * viewed user from their own co-member grid. Never filtered in memory.
   * Absent/"" on the standalone `/communities/:id/members` endpoint.
   */
  excludeUserId?: string;
  /** "username" | "handle" | "joinedAt" — passed through to community-service ("" = default). */
  sortField?: string;
  /** "asc" | "desc" — passed through to community-service ("" = default asc). */
  sortDir?: string;
};

// ---------------------------------------------------------------------------
// Muted-members list (platform-admin view of a community's moderation mutes).
// Read-through from community-service over gRPC — no community-membership gate.
// ---------------------------------------------------------------------------

/** A single row in the muted-members grid. */
export type CommunityMutedMemberRow = {
  userId: string;
  /** Display name (falls back to the @handle when no display name). */
  username: string;
  /** The @handle (snapshot username). */
  handle: string;
  // Standard avatar object (see @aimess/shared-types MediaObject); null when
  // the member has no avatar. Replaces the legacy bare avatarUrl string.
  avatar: MediaObject | null;
  /** AuthUser.id of the moderator/admin who applied the mute. */
  mutedBy: string;
  reason: string | null;
  /** epoch ms. */
  mutedAt: number;
  /** epoch ms, or null when the mute is indefinite. */
  mutedUntil: number | null;
};

/** Normalized muted-members query (post-validation/coercion). */
export type ListMutedMembersQuery = {
  page: number;
  limit: number;
};

// ---------------------------------------------------------------------------
// User → Communities reverse lookup (the "Communities" grid on the admin User
// Management detail screen). Read-through from community-service over gRPC.
// ---------------------------------------------------------------------------

/** A single row in the user's communities grid. */
export type UserCommunityRow = {
  communityId: string;
  name: string;
  // Standard avatar object (see @aimess/shared-types MediaObject); null when
  // the community has no avatar. Replaces the legacy bare avatarUrl string.
  avatar: MediaObject | null;
  category: { id: string; name: string };
  description: string;
  memberCount: number;
  /** This user's role within the community (ADMIN|MODERATOR|MEMBER). */
  role: string;
  /** This user's joinedAt (epoch ms). */
  joinedAt: number;
  /** Community createdAt (epoch ms). */
  createdAt: number;
};

/** Normalized user-communities query (post-validation/coercion). */
export type ListUserCommunitiesQuery = {
  search?: string;
  /** Canonical field consumed by community-service: name|memberCount|createdAt. */
  sortField: "name" | "memberCount" | "createdAt";
  sortDir: "asc" | "desc";
  page: number;
  limit: number;
};

/** Normalized list query (post-validation/coercion). */
export type ListCommunitiesQuery = {
  search?: string;
  type?: CommunityType;
  category?: string;
  status?: CommunityModerationStatus;
  /** Canonical `<field>:<dir>` token the repo consumes (e.g. `categoryName:asc`). */
  sort: string;
  /** Resolved UI sort column (`category` | `members` | `createdDate`) — audit echo. */
  sortBy: string;
  /** Resolved UI sort direction (`asc` | `desc`) — audit echo. */
  sortOrder: "asc" | "desc";
  page: number;
  limit: number;
  createdFrom?: string;
  createdTo?: string;
};
