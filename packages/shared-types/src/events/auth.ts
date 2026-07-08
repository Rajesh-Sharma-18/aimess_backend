/** Cross-service auth domain events (auth-service → notifications-service). */
export const AuthEvents = {
  PASSWORD_RESET_OTP_REQUESTED: "auth.password_reset_otp_requested",
  LINK_EMAIL_OTP_REQUESTED: "auth.link_email_otp_requested",
  CHANGE_EMAIL_OTP_REQUESTED: "auth.change_email_otp_requested",
  SECURITY_NEW_LOGIN: "auth.security_new_login",
  PASSWORD_CHANGED: "auth.password_changed",
  EMAIL_CHANGED: "auth.email_changed",
} as const;

export type AuthEventType = (typeof AuthEvents)[keyof typeof AuthEvents];

export type PasswordResetOtpRequestedPayload = {
  email: string;
  code: string;
  ttlSeconds: number;
  /** ISO-8601 timestamp captured at publish time. */
  requestedAt: string;
};

export type LinkEmailOtpRequestedPayload = {
  email: string;
  code: string;
  ttlSeconds: number;
  /** ISO-8601 timestamp captured at publish time. */
  requestedAt: string;
};

export type ChangeEmailOtpRequestedPayload = {
  email: string;
  code: string;
  ttlSeconds: number;
  /** ISO-8601 timestamp captured at publish time. */
  requestedAt: string;
};

export type SecurityNewLoginPayload = {
  userId: string;
  /** ISO-8601 timestamp the login completed. */
  at: string;
};

export type PasswordChangedPayload = {
  userId: string;
  /** ISO-8601 timestamp the password was updated. */
  at: string;
};

export type EmailChangedPayload = {
  userId: string;
  newEmail: string;
  /** ISO-8601 timestamp the email was updated. */
  at: string;
};
