/** Cross-service admin auth domain events (backoffice-service → notifications-service). */
export const AdminAuthEvents = {
  PASSWORD_RESET_OTP_REQUESTED: "admin.password_reset_otp_requested",
} as const;

export type AdminAuthEventType =
  (typeof AdminAuthEvents)[keyof typeof AdminAuthEvents];

export type AdminPasswordResetOtpRequestedPayload = {
  email: string;
  code: string;
  ttlSeconds: number;
  /** ISO-8601 timestamp captured at publish time. */
  requestedAt: string;
  /**
   * Language the request that triggered this email was made in (`x-lang`).
   * Optional and additive: an older publisher omits it and the email falls back
   * to the default locale, exactly as before.
   */
  locale?: string;
};

/**
 * Cross-service admin account-state events (backoffice-service → auth-service).
 * Published by backoffice on ban/suspend/unban to the durable `admin.user.queue`;
 * auth-service is the sole consumer (revokes sessions + re-publishes a notify).
 * String values MUST match backoffice ADMIN_USER_EVENTS — the wire contract.
 */
export const AdminUserEvents = {
  USER_BANNED: "admin.user_banned",
  USER_UNBANNED: "admin.user_unbanned",
  USER_SUSPENDED: "admin.user_suspended",
} as const;

export type AdminUserEventType =
  (typeof AdminUserEvents)[keyof typeof AdminUserEvents];

/**
 * Payload carried by every admin.user_* event. Mirrors the backoffice publisher
 * (apps/backoffice-service/src/messaging/publish-admin-user-event.ts) exactly —
 * `forceLogout`/`notifyUser` are the action flags the auth-service consumer
 * honors; both are absent on unban events.
 */
export type AdminUserEventPayload = {
  userId: string;
  reason?: string | null;
  suspendedUntil?: string | null;
  forceLogout?: boolean;
  notifyUser?: boolean;
  actorId: string;
  /** ISO timestamp the mutation was applied. */
  at: string;
};

/**
 * Notify-ready payload on `admin.user.notify.queue`: auth-service re-publishes
 * admin ban/suspend/unban actions here after processing admin.user.queue, and
 * notifications-service consumes them → pushToUser. `type` is the domain event
 * (e.g. admin.user_banned) persisted on the inbox row; `data` is extra
 * string→string context (actorId, reason, suspendedUntil).
 */
export type AdminUserNotifyPayload = {
  userId: string;
  type: string;
  title: string;
  body: string;
  data?: Record<string, string>;
};

/** Cross-service admin report-ingestion events (community/chat → backoffice-service). */
export const AdminReportEvents = {
  REPORT_INGEST: "admin.report.ingest",
} as const;

export type AdminReportEventType =
  (typeof AdminReportEvents)[keyof typeof AdminReportEvents];

/**
 * Normalized report payload written to admin_db.Report by the backoffice
 * consumer. `details` is upstream free-text (null when the source has none).
 * `sourceReportId` is the upstream report row's own id (traceability).
 * `communityId` is the community the report was filed in (community-service
 * member/community reports only; null/omitted for community-less reports
 * such as chat-service private-message reports).
 */
export type AdminReportIngestPayload = {
  type: "user" | "community" | "message" | "stream";
  targetId: string;
  reporterId: string;
  reason: string;
  details: string | null;
  communityId?: string | null;
  /**
   * The reported USER when the target itself isn't a user — i.e. the message
   * sender for `message` reports, the comment author for `stream` reports.
   * Omitted for `user` (already the target) and `community` reports.
   */
  reportedUserId?: string | null;
  /**
   * Conversation the report was filed from. `roomId` is the private room id,
   * group room id, or community id; `roomType` names which. Carried so a
   * moderator reading admin_db.Report can tell WHERE a reported user/message
   * lives — previously only community reports had any context at all.
   */
  roomId?: string | null;
  roomType?: "PRIVATE" | "GROUP" | "COMMUNITY" | null;
  /** ISO-8601 timestamp captured at publish time. */
  eventAt: string;
  sourceReportId: string;
};

// Cross-service end-user activity ingestion (auth/user/community/chat/stream → backoffice-service).
export const AdminActivityEvents = {
  ACTIVITY_INGEST: "admin.activity.ingest",
} as const;

export type AdminActivityEventType =
  (typeof AdminActivityEvents)[keyof typeof AdminActivityEvents];

// Who performed a website-side action: an end user, or the platform itself (jobs/sweepers).
export type AdminActivityActorType = "USER" | "SYSTEM";

// Which client the action came from. Mirrors AUDIT_SOURCES in @aimess/constants
// and the AuditSource enum in admin_db — kept as a literal union here so
// shared-types stays dependency-free.
export type AdminActivitySource =
  | "ADMIN_PANEL"
  | "WEB"
  | "ANDROID"
  | "IOS"
  | "SYSTEM";

// One end-user action, normalized into the same shape backoffice's AuditLog stores.
export type AdminActivityIngestPayload = {
  // AuthUser.id (UUID). Null for SYSTEM actors — no user performed the action.
  actorId: string | null;
  actorType: AdminActivityActorType;
  // Client the action originated from, derived server-side at the request boundary
  // (never a raw client-declared value). Absent on messages from an older publisher.
  source?: AdminActivitySource;
  // Domain action name, e.g. "user.login" — MUST exist in backoffice USER_AUDIT_ACTIONS.
  action: string;
  targetType: string;
  targetId?: string | null;
  // Free-form context stored verbatim on the audit row (the `reason` key is surfaced in the UI).
  before?: unknown;
  after?: unknown;
  ip?: string | null;
  userAgent?: string | null;
  /** ISO-8601 timestamp captured at publish time. */
  eventAt: string;
  // Publisher-generated idempotency key — a redelivered message re-inserts and is swallowed as a no-op.
  eventId: string;
};
