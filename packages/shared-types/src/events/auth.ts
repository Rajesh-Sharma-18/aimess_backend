/** Cross-service auth domain events (auth-service → notifications-service). */
export const AuthEvents = {
  PASSWORD_RESET_OTP_REQUESTED: "auth.password_reset_otp_requested",
} as const;

export type AuthEventType = (typeof AuthEvents)[keyof typeof AuthEvents];

export type PasswordResetOtpRequestedPayload = {
  email: string;
  code: string;
  ttlSeconds: number;
  /** ISO-8601 timestamp captured at publish time. */
  requestedAt: string;
};
