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
