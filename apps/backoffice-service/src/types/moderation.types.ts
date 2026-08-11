/**
 * View-model types for the Reports & Moderation admin API.
 * These mirror the JSON contract in docs/REPORTS-MODERATION-API-SPEC.md exactly
 * (field names + casing). They are the shapes the repository returns and the
 * controllers serialize — stable across Phase 1 (mock) and Phase 2 (Prisma).
 */

import type { MediaObject } from "@aimess/shared-types";

export type ReportType =
  | "SPAM"
  | "HARASSMENT"
  | "HATE_SPEECH"
  | "NUDITY"
  | "VIOLENCE"
  | "SELF_HARM"
  | "IMPERSONATION"
  | "MISINFORMATION"
  | "ILLEGAL_CONTENT"
  | "CSAM"
  | "TERRORISM"
  | "OTHER";

export type TargetType =
  | "USER"
  | "MESSAGE"
  | "GROUP"
  | "COMMUNITY"
  | "POST"
  | "COMMENT"
  | "MEDIA"
  | "STREAM";

export type ReportStatus =
  | "PENDING"
  | "UNDER_REVIEW"
  | "RESOLVED"
  | "DISMISSED"
  | "ESCALATED";

export type ReportPriority = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type EvidenceType =
  | "MESSAGE_SNAPSHOT"
  | "ATTACHMENT"
  | "SCREENSHOT"
  | "PROFILE_SNAPSHOT"
  | "LINK"
  | "SYSTEM_LOG";

export type AccountStatus = "ACTIVE" | "SUSPENDED" | "BANNED" | "DELETED";

export type ResolutionType =
  | "ACTION_TAKEN"
  | "WARNING_ISSUED"
  | "CONTENT_REMOVED";

export type ActionOnReportedUser =
  | "NONE"
  | "WARN"
  | "CONTENT_REMOVE"
  | "MUTE"
  | "SUSPEND_7D"
  | "SUSPEND_30D"
  | "BAN";

export type DismissReason =
  | "NO_VIOLATION"
  | "INSUFFICIENT_EVIDENCE"
  | "DUPLICATE"
  | "FALSE_REPORT";

/** Compact user reference shown in the list table. */
export type UserRef = {
  id: string;
  username: string;
  displayName: string;
  firstName: string;
  lastName: string;
  // Standard avatar object (see @aimess/shared-types MediaObject); null when
  // no avatar is set. Replaces the legacy bare avatarUrl string.
  avatar: MediaObject | null;
  accountStatus?: AccountStatus;
};

/** Moderator stamp once a report has been actioned. */
export type ModeratorRef = {
  id: string;
  name: string;
};

/** A single row in the reports table (list projection). */
export type ReportListItem = {
  reportId: string;
  // null when the report target isn't a user (e.g. a COMMUNITY/STREAM report)
  // or the user-service profile lookup came back empty.
  reportedUser: UserRef | null;
  reporterUser: UserRef | null;
  reportType: ReportType;
  targetType: TargetType;
  status: ReportStatus;
  priority: ReportPriority;
  createdAt: number;
  resolvedAt: number | null;
  moderator: ModeratorRef | null;
  // Name of the community the report was filed in, resolved live from
  // community-service via communityId; null for community-less reports
  // (e.g. private-message reports).
  communityName: string | null;
};

/** Full reported-user profile with moderation signals (detail view). */
export type ReportedUserProfile = UserRef & {
  accountStatus: AccountStatus;
  joinedAt: number;
  priorReportsCount: number;
  priorActionsCount: number;
};

/** Full reporter profile with moderation signals (detail view). */
export type ReporterUserProfile = UserRef & {
  accountStatus: AccountStatus;
  reportsFiledCount: number;
  falseReportRate: number;
};

/** The reported entity snapshot. */
export type ReportTarget = {
  type: TargetType;
  id: string;
  conversationId?: string;
  snapshot?: Record<string, unknown>;
  deepLink?: string;
};

export type EvidenceItem = {
  id: string;
  type: EvidenceType;
  capturedAt?: number;
  mimeType?: string;
  url?: string;
  thumbnailUrl?: string;
  sizeBytes?: number;
  restricted?: boolean;
  content?: Record<string, unknown>;
};

export type HistoryItem = {
  id: string;
  action: string;
  actorType: "USER" | "ADMIN" | "SYSTEM";
  actorId: string | null;
  actorName: string | null;
  at: number;
  note: string | null;
};

export type RelatedReport = {
  reportId: string;
  reportType: ReportType;
  status: ReportStatus;
  createdAt: number;
};

/** The full report detail returned by GET /reports/{reportId}. */
/** Which kind of conversation a report was filed from. */
export type ConversationKind = "PRIVATE" | "GROUP" | "COMMUNITY";

export type ReportDetail = {
  reportId: string;
  reportType: ReportType;
  targetType: TargetType;
  status: ReportStatus;
  priority: ReportPriority;
  reason: string;
  reporterNote: string | null;
  sourceService: string;
  // Community the report was filed in (community-service member/community
  // reports only); null for community-less reports (e.g. chat-service
  // private-message reports). Mirrors Report.communityId in admin_db.
  communityId: string | null;
  // Resolved live from community-service via communityId on every read —
  // never persisted, so it can't go stale.
  communityName: string | null;
  // Conversation the report was filed from — private room id / group room id /
  // community id + which of the three. Null on rows ingested before the context
  // was carried, so the FE must render it as optional.
  roomId: string | null;
  roomType: ConversationKind | null;
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
  slaDueAt: number | null;
  reportedUser: ReportedUserProfile | null;
  reporterUser: ReporterUserProfile | null;
  target: ReportTarget;
  evidence: EvidenceItem[];
  history: HistoryItem[];
  relatedReports: RelatedReport[];
  availableActions: string[];
  // Decision fields — populated once actioned.
  resolution?: ResolutionType | null;
  dismissReason?: DismissReason | null;
  decisionNote?: string | null;
  moderator?: ModeratorRef | null;
};

/** Core report detail returned by GET /reports/{reportId} — sub-resources served separately. */
export type ReportCore = Omit<
  ReportDetail,
  "evidence" | "history" | "relatedReports"
>;

/** Query for GET /reports/:reportId/evidence */
export type ListReportEvidenceQuery = { page: number; limit: number };

/** Query for GET /reports/:reportId/history */
export type ListReportHistoryQuery = { page: number; limit: number };

/** Query for GET /reports/:reportId/related */
export type ListReportRelatedQuery = { page: number; limit: number };

/** Pagination envelope (shared by list endpoints). */
export type PaginationMeta = {
  mode: "offset" | "keyset";
  page: number;
  limit: number;
  total: number | null;
  totalApprox: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
  nextCursor: string | null;
};

/** Generic paginated result from the repository. */
export type Paginated<T> = {
  data: T[];
  pagination: PaginationMeta;
};

export type AppliedAction = {
  type: ActionOnReportedUser;
  targetUserId: string;
  effectiveUntil: number | null;
};

/** Result of a resolve action. */
export type ResolveResult = {
  reportId: string;
  status: ReportStatus;
  resolution: ResolutionType;
  resolvedAt: number;
  moderator: ModeratorRef;
  appliedActions: AppliedAction[];
};

/** Result of a dismiss action. */
export type DismissResult = {
  reportId: string;
  status: ReportStatus;
  dismissReason: DismissReason;
  resolvedAt: number;
  moderator: ModeratorRef;
};

/** Union of single-action results. */
export type ReportActionResult = ResolveResult | DismissResult;

/** One entry in a bulk operation's result list. */
export type BulkResultItem =
  | { reportId: string; status: ReportStatus; ok: true }
  | {
      reportId: string;
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
export type ListReportsQuery = {
  search?: string;
  reportType?: ReportType[];
  status?: ReportStatus[];
  targetType?: TargetType;
  assignedTo?: string;
  communityId?: string;
  sort: string;
  page: number;
  limit: number;
  cursor?: string;
  dateFrom?: string;
  dateTo?: string;
};

// ---------------------------------------------------------------------------
// Reports & Moderation Details page — GET /reports/{reportId} aggregate.
// ---------------------------------------------------------------------------

/** Compact user reference for the Reports & Moderation Details page. */
export type ReportModerationUserRef = {
  id: string;
  username: string;
  firstName: string;
  lastName: string;
  fullName: string;
  avatar: MediaObject | null;
};

/**
 * Explicit report-kind identifier for the Reports & Moderation Details page —
 * derived from the REPORTED ENTITY (not the reason category). A community
 * itself is never reportable; inside a community a reported MEMBER is a
 * COMMUNITY report and a reported MESSAGE is a MESSAGE report. A reported user
 * outside any community is a USER report.
 *   USER       → private (non-community) user report
 *   COMMUNITY  → community member report
 *   LIVESTREAM → livestream report
 *   MESSAGE    → community message report
 * Future: COMMENT (livestream comment) — mapping kept commented below until
 * the backend grows a comment entity + report path.
 */
export type ReportModerationKind =
  | "USER"
  | "COMMUNITY"
  | "LIVESTREAM"
  | "MESSAGE";
// | "COMMENT"; // (Future) livestream comment reports — not yet wired.

/** "community" block — compact community reference. */
export type CommunityReportBlock = {
  id: string;
  name: string;
  handle: string;
  avatar: MediaObject | null;
};

/**
 * "livestream" block — the reported stream's useful details, sourced from the
 * existing stream-service admin read (`streamClient.adminGetStream`).
 */
export type LivestreamReportBlock = {
  id: string;
  title: string;
  description: string;
  status: string;
  thumbnail: MediaObject | null;
  /** Total distinct viewers (ended) or running total (live). */
  viewerCount: number;
  /** Currently watching; 0 once the stream has ended. */
  activeViewerCount: number;
  /** Milliseconds. */
  duration: number;
  startedAt: number | null;
  endedAt: number | null;
  host: ReportModerationUserRef | null;
};

/**
 * "message" block — the reported community message. Content fields are
 * best-effort: there is no admin message-content-fetch RPC into chat-service
 * yet, so a message report currently exposes the identifiers it carries
 * (id/senderId) with content/media null until that path exists. Shape matches
 * the eventual full contract so the FE can type against it now.
 */
export type MessageReportBlock = {
  id: string;
  messageType: string | null;
  text: string | null;
  content: string | null;
  media: MediaObject[];
  sentAt: number | null;
  senderId: string | null;
  /** Conversation the reported message lives in (see ReportDetail.roomId). */
  roomId: string | null;
  roomType: ConversationKind | null;
};

// ---------------------------------------------------------------------------
// Report Details "Users" list — GET /reports/{reportId}/users.
// One endpoint serving BOTH report kinds: COMMUNITY/MESSAGE reports return the
// reported community's members; LIVESTREAM reports return the stream's viewer
// sessions. Reuses communityMembersRepository / livestreamRepository — no new
// read path. Shape is unified across both sources.
// ---------------------------------------------------------------------------

/** One row in the Report Details users list. */
export type ReportUserItem = {
  userId: string;
  username: string;
  displayName: string;
  avatar: MediaObject | null;
  /** Community: ADMIN|MODERATOR|MEMBER|BANNED. Livestream: Admin|Moderator|Member. */
  role: string;
  /** epoch ms. */
  joinedAt: number;
};

/** Slim pagination for the report users list (matches the FE contract). */
export type ReportUsersPagination = {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
};

/** Normalized query for GET /reports/:reportId/users (post-validation/coercion). */
export type ListReportUsersQuery = {
  search?: string;
  /** Community role filter (ADMIN|MODERATOR|MEMBER); ignored for livestream reports. */
  role?: string;
  page: number;
  limit: number;
  sortBy: "username" | "joinedAt" | "role";
  sortDir: "asc" | "desc";
};

/**
 * (Future) "comment" block for COMMENT (livestream comment) reports — kept
 * commented until the backend grows a comment entity + report-ingest path.
 *
 * export type CommentReportBlock = {
 *   id: string;
 *   message: string | null;
 *   sender: ReportModerationUserRef | null;
 *   livestream: { id: string; title: string } | null;
 *   createdAt: number | null;
 * };
 */

/**
 * One row in the "Community Members" grid on the Reports & Moderation Details
 * page. Reuses `communityMembersRepository.listMembers` for pagination/search/
 * role-filter/sort, enriched with `fullname` (user-service) and `sequenceNo`
 * (page-relative row number).
 */
export type ReportModerationMemberRow = {
  sequenceNo: number;
  id: string;
  username: string;
  fullname: string | null;
  avatar: string | null;
  joinedAt: number;
  role: import("./community.types.js").CommunityMemberRole;
};

/** "Community Member List" block — reuses `communityMembersRepository.listMembers`. */
export type CommunityMembersBlock = {
  items: ReportModerationMemberRow[];
  pagination: PaginationMeta;
};

/**
 * Full aggregate returned by GET /reports/{reportId} for the admin Reports &
 * Moderation Details page. Preserves the original flat structure (id /
 * reportReason / reportMessage / reportStatus / reporter / reportedUser /
 * community / communityAdmin) and adds `reportType` (the reported-entity kind)
 * plus the entity-specific `livestream` / `message` blocks. Entity blocks are
 * present only for the report types that use them (see {@link ReportModerationKind}):
 *   USER       → reportedUser
 *   COMMUNITY  → reportedUser, community, communityAdmin
 *   LIVESTREAM → reportedUser, community, communityAdmin, livestream
 *   MESSAGE    → reportedUser, community, communityAdmin, message
 */
export type ReportModerationDetail = {
  id: string;
  reportType: ReportModerationKind;
  reportReason: string;
  reportMessage: string | null;
  reportStatus: ReportStatus;
  createdAt: number;
  updatedAt: number;
  reporter: ReportModerationUserRef | null;
  reportedUser: ReportModerationUserRef | null;
  // Conversation the report was filed from (null for legacy rows).
  roomId: string | null;
  roomType: ConversationKind | null;
  // Present for COMMUNITY / LIVESTREAM / MESSAGE reports (omitted for USER).
  community?: CommunityReportBlock | null;
  communityAdmin?: ReportModerationUserRef | null;
  // Present only for LIVESTREAM reports.
  livestream?: LivestreamReportBlock | null;
  // Present only for MESSAGE reports.
  message?: MessageReportBlock | null;
};
