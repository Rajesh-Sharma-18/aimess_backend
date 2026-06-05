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
