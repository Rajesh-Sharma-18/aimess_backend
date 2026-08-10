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
  /**
   * Language the request that triggered this email was made in (`x-lang`).
   * Optional and additive: an older publisher omits it and the email falls back
   * to the default locale, exactly as before.
   */
  locale?: string;
};

export type LinkEmailOtpRequestedPayload = {
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

export type ChangeEmailOtpRequestedPayload = {
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

export type SecurityNewLoginPayload = {
  userId: string;
  /** ISO-8601 timestamp the login completed. */
  at: string;
  /**
   * Id of the session/device just created — lets the client render the alert
   * and drive the existing "Terminate Session" flow. Optional for backward
   * compatibility with any already-queued events lacking it.
   */
  sessionId?: string;
  /** Composite device label, e.g. "iPhone · Chrome · iOS". */
  deviceName?: string | null;
  /** Platform bucket, e.g. WEB / ANDROID / IOS / DESKTOP. */
  deviceType?: string | null;
  /** Raw client IP (masked before it reaches the client). */
  ipAddress?: string | null;
  /** ISO country code when geo is available (not populated yet). */
  countryCode?: string | null;
  /** Browser name parsed from the user agent, e.g. "Chrome". */
  browser?: string | null;
  /** OS name parsed from the user agent, e.g. "Windows". */
  os?: string | null;
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
