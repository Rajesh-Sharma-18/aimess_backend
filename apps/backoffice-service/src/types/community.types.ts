/**
 * View-model types for the Community Management admin API.
 * These mirror the JSON contract agreed with the frontend (field names + casing).
 * They are the shapes the repository returns and the controllers serialize —
 * stable across Phase 1 (mock fixtures) and Phase 2 (gRPC → community/stream/user).
 */

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
  avatarUrl: string | null;
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
  admin: CommunityAdminRef;
  type: CommunityType;
  category: CategoryRef;
  status: CommunityModerationStatus;
  memberCount: number;
  livestreamCount: LivestreamCounter;
  createdAt: string;
  actions: CommunityActions;
};

/** Full owner profile with moderation signals (detail view). */
export type CommunityOwner = {
  userId: string;
  displayName: string;
  username: string;
  avatarUrl: string | null;
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
  createdAt: string;
  metadata: Record<string, unknown>;
};

/** Quick settings snapshot shown on the detail header. */
export type CommunitySettingsSummary = {
  joinPolicy: string;
  type: CommunityType;
  memberCount: number;
  inviteLinksActive: number;
  openReports: number;
  createdAt: string;
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
  avatarUrl: string | null;
  coverUrl: string | null;
  createdAt: string;
  lastActivityAt: string;
};

/** The full community detail returned by GET /communities/{communityId}. */
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
  closedAt: string;
  reasonCode: CloseReasonCode;
  moderationActionId: string;
  auditLogId: string;
};

/** Result of a reopen action (audit/moderation ids attached by the service). */
export type ReopenResult = {
  communityId: string;
  status: CommunityModerationStatus;
  reopenedAt: string;
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

/** Normalized list query (post-validation/coercion). */
export type ListCommunitiesQuery = {
  search?: string;
  type?: CommunityType;
  category?: string;
  status?: CommunityModerationStatus;
  sort: string;
  page: number;
  limit: number;
  createdFrom?: string;
  createdTo?: string;
};
