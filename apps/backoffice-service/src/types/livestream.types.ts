/**
 * View-model types for the Livestream Management admin API.
 * These mirror the JSON contract in docs/LIVESTREAM-MANAGEMENT-API-SPEC.md exactly
 * (field names + casing). They are the shapes the repository returns and the
 * controllers serialize — stable across Phase 1 (mock) and Phase 2 (Prisma/OSSRS).
 *
 * Pagination + AccountStatus are reused from moderation.types to avoid
 * duplicating the shared envelope/enum across slices.
 */
import type { MediaObject } from "@aimess/shared-types";

import type {
  AccountStatus,
  Paginated,
  PaginationMeta,
} from "./moderation.types.js";

// Re-export the shared shapes so consumers of this slice can import them
// from a single place (mirrors how moderation.types owns them).
export type { AccountStatus, Paginated, PaginationMeta };

// SCHEDULED is the admin-facing label for a stream-service PENDING stream
// (created but not yet live). The repository maps PENDING⇄SCHEDULED at the edge.
export type LivestreamStatus = "LIVE" | "ENDED" | "CANCELLED" | "SCHEDULED";

export type EndReasonCode =
  | "POLICY_VIOLATION"
  | "COMMUNITY_GUIDELINES"
  | "SPAM"
  | "HARASSMENT"
  | "COPYRIGHT"
  | "NUDITY"
  | "VIOLENCE"
  | "MANUAL_ADMIN";

export type ReportSeverity = "NONE" | "LOW" | "MEDIUM" | "HIGH";

export type LivestreamReportType =
  | "HARASSMENT"
  | "SPAM"
  | "COPYRIGHT"
  | "NUDITY"
  | "VIOLENCE"
  | "HATE_SPEECH"
  | "OTHER";

export type LivestreamReportStatus =
  | "OPEN"
  | "REVIEWING"
  | "RESOLVED"
  | "DISMISSED";

/** Compact category reference. */
export type LivestreamCategoryRef = {
  id: string;
  name: string;
  slug: string;
};

/** Compact community reference shown in the list table. */
export type CommunityRef = {
  id: string;
  name: string;
  slug: string;
  // Standard avatar object (see @aimess/shared-types MediaObject) — matches the
  // shape used across User APIs / Community Details. Replaces the legacy bare
  // avatarUrl string; null when no avatar is set.
  avatar: MediaObject | null;
};

/** Compact creator reference shown in the list table. */
export type CreatorRef = {
  id: string;
  username: string;
  displayName: string;
  // Standard avatar object (see @aimess/shared-types MediaObject) — matches the
  // shape used across User APIs / Community Details. Replaces the legacy bare
  // avatarUrl string; null when no avatar is set.
  avatar: MediaObject | null;
};

/** A single row in the livestreams table (list projection). */
export type LivestreamListItem = {
  livestreamId: string;
  title: string;
  community: CommunityRef;
  creator: CreatorRef;
  category: LivestreamCategoryRef;
  createdAt: number;
  startedAt: number;
  /** null while the stream is LIVE. */
  endedAt: number | null;
  durationSeconds: number;
  status: LivestreamStatus;
  viewerCount: number;
  reportCount: number;
  reportSeverity: ReportSeverity;
  thumbnailUrl: string | null;
};

/** Live/aggregate viewer telemetry (detail view). */
export type ViewerStats = {
  currentViewers: number;
  peakViewers: number;
  totalUniqueViewers: number;
  totalWatchTimeSeconds: number;
  averageWatchTimeSeconds: number;
  chatMessageCount: number;
};

/** Per-type breakdown of reports filed against a stream. */
export type ReportsByType = Record<LivestreamReportType, number>;

/** Roll-up of all reports filed against a stream (detail view). */
export type ReportsSummary = {
  total: number;
  open: number;
  reviewing: number;
  resolved: number;
  dismissed: number;
  severity: ReportSeverity;
  byType: ReportsByType;
  firstReportedAt: number | null;
  lastReportedAt: number | null;
};

/** Ingest/playback technical metadata (detail view). NO raw stream key exposed. */
export type StreamMetadata = {
  ingestProtocol: string;
  playbackUrl: string;
  resolution: string;
  bitrateKbps: number;
  fps: number;
  region: string;
  isRecording: boolean;
  recordingUrl: string | null;
};

/** Creator profile with moderation signals (detail view). */
export type CreatorProfile = CreatorRef & {
  accountStatus: AccountStatus;
  totalStreams: number;
  priorStrikes: number;
};

/** Community context for the stream (detail view). */
export type CommunityContext = CommunityRef & {
  memberCount: number;
  creatorRole: string;
};

/** One entry in the per-stream moderation timeline. */
export type LivestreamModerationHistoryItem = {
  id: string;
  action: string;
  adminId: string;
  adminName: string;
  reasonCode: string | null;
  note: string | null;
  createdAt: number;
};

/** A single report filed against a livestream. */
export type LivestreamReportItem = {
  reportId: string;
  livestreamId: string;
  reporter: {
    id: string;
    username: string;
    displayName: string;
  };
  reportType: LivestreamReportType;
  description: string;
  status: LivestreamReportStatus;
  resolution: null | {
    action: string;
    note: string | null;
    resolvedBy: string;
    resolvedAt: number;
  };
  createdAt: number;
  evidence: {
    timestampSeconds: number | null;
    clipUrl: string | null;
  };
};

/** The full livestream detail returned by GET /livestreams/{livestreamId}. */
export type LivestreamDetail = {
  livestreamId: string;
  title: string;
  description: string;
  community: CommunityContext;
  creator: CreatorProfile;
  category: LivestreamCategoryRef;
  createdAt: number;
  startedAt: number;
  /** null while the stream is LIVE. */
  endedAt: number | null;
  durationSeconds: number;
  status: LivestreamStatus;
  viewerCount: number;
  reportCount: number;
  reportSeverity: ReportSeverity;
  thumbnailUrl: string | null;
  /** Reason the stream was ended by an admin (null otherwise). */
  endReasonCode: EndReasonCode | null;
  /** Admin who ended the stream (null otherwise). */
  endedBy: { adminId: string; adminName: string } | null;
  viewerStats: ViewerStats;
  streamMetadata: StreamMetadata;
  reportsSummary: ReportsSummary;
  moderationHistory: LivestreamModerationHistoryItem[];
  /** Self-contained list of reports so the per-stream endpoint needs no join. */
  reports: LivestreamReportItem[];
};

/** Result of ending a single livestream. */
export type EndLivestreamResult = {
  livestreamId: string;
  status: "ENDED";
  endedAt: number;
  endedBy: { adminId: string; adminName: string };
  reasonCode: EndReasonCode;
  moderationActionId: string;
  /** null in mock mode — Phase 2 returns the persisted audit-log row id. */
  auditLogId: string | null;
  creatorNotified: boolean;
  strikeIssued: boolean;
};

/** One entry in a bulk operation's result list. */
export type BulkResultItem =
  | { id: string; status: string; ok: true }
  | {
      id: string;
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

/** Bulk-end alias (same shape as BulkResult). */
export type BulkEndResult = BulkResult;
/** Bulk-review alias (same shape as BulkResult). */
export type BulkReviewResult = BulkResult;

/** Normalized list query (post-validation/coercion). */
export type ListLivestreamsQuery = {
  search?: string;
  category?: string;
  status?: LivestreamStatus;
  hasReports?: boolean;
  minReports?: number;
  communityId?: string;
  creatorId?: string;
  sort: string;
  page: number;
  limit: number;
  cursor?: string;
  dateFrom?: string;
  dateTo?: string;
};

/** Normalized per-stream reports list query (post-validation/coercion). */
export type ListLivestreamReportsQuery = {
  status?: LivestreamReportStatus;
  reportType?: LivestreamReportType;
  sort: string;
  page: number;
  limit: number;
  cursor?: string;
};

/**
 * One row in the per-livestream "Livestream User List" — an actual viewer
 * session (who watched, when, for how long), backed by stream-service's
 * durable `LivestreamViewerSession` table. A user who rejoined has multiple
 * rows (one per join→leave session).
 */
/** Community role of a viewer, as shown in the admin viewer-list "type" column. */
export type LivestreamViewerType = "Admin" | "Moderator" | "Member";

export type LivestreamUserItem = {
  /** Pagination-based sequence number: (page - 1) * limit + index + 1. */
  no: number;
  userId: string;
  username: string;
  handle: string | null;
  // Standard avatar object (see @aimess/shared-types MediaObject); null when
  // no avatar is set. Replaces the legacy bare avatarUrl string.
  avatar: MediaObject | null;
  /** epoch ms — when this viewing session started. */
  joinedAt: number;
  /** epoch ms; null = still watching. */
  leftAt: number | null;
  /** Computed live (now - joinedAt) while still watching. */
  watchDurationSeconds: number;
  /** Viewer's current community role; defaults to "Member" if not a member. */
  type: LivestreamViewerType;
};

/** Normalized per-stream viewers list query (post-validation/coercion). */
export type ListLivestreamUsersQuery = {
  page: number;
  limit: number;
  /**
   * joinedAt|watchDurationSeconds sort natively at the DB (fast path). username|
   * role sort — and any search/role filter — have no backing column on the
   * viewer-session store, so they trigger the bounded candidate-set enrichment
   * path (see {@link GrpcLivestreamRepository.listUsers}).
   */
  sortField?: "joinedAt" | "watchDurationSeconds" | "username" | "role";
  sortDir?: "asc" | "desc";
  /** Case-insensitive partial match on username / display name / user id. */
  search?: string;
  /** Community-role filter (Admin|Moderator|Member) — the only implemented viewer role. */
  role?: string;
};
