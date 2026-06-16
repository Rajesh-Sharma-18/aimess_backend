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
 */
export type AdminReportIngestPayload = {
  type: "user" | "community" | "message" | "stream";
  targetId: string;
  reporterId: string;
  reason: string;
  details: string | null;
  /** ISO-8601 timestamp captured at publish time. */
  eventAt: string;
  sourceReportId: string;
};
