import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]),

  AUTH_SERVICE_PORT: z.coerce.number(),
  AUTH_GRPC_PORT: z.coerce.number().positive().default(4001),

  AUTH_DATABASE_URL: z.string(),

  REDIS_HOST: z.string(),
  REDIS_PORT: z.coerce.number(),
  // Optional so local dev against an unauthenticated Redis keeps working.
  // Required for any shared/remote Redis, which must not be left open.
  REDIS_PASSWORD: z.string().optional(),

  JWT_ACCESS_SECRET: z.string(),
  JWT_REFRESH_SECRET: z.string(),
  CORS_ALLOWED_ORIGINS: z.string().min(1),
  JWT_ACCESS_EXPIRES_IN: z.string(),
  JWT_REFRESH_EXPIRES_IN: z.string(),
  /**
   * Refresh-token lifetime (seconds) when the user opts into "remember me" at
   * login. Falls back to 30 days. The access-token lifetime is unaffected.
   */
  JWT_REFRESH_EXPIRES_IN_REMEMBER_ME: z.string().default("2592000"),

  RABBITMQ_URL: z.string().min(1),

  OTP_LENGTH: z.coerce.number().int().min(4).max(8).default(6),
  OTP_TTL_SECONDS: z.coerce.number().positive().default(600),
  OTP_MAX_ATTEMPTS: z.coerce.number().positive().default(5),
  PASSWORD_RESET_TOKEN_TTL_SECONDS: z.coerce.number().positive().default(900),

  /** Failed-login attempts before the account is temporarily locked. */
  AUTH_MAX_FAILED_LOGINS: z.coerce.number().int().positive().default(5),
  /** Lockout window (minutes) applied once the failed-login threshold is hit. */
  AUTH_LOCKOUT_MINUTES: z.coerce.number().int().positive().default(15),

  /** Max OTP issuance requests per identifier within the window below. */
  OTP_REQUEST_MAX: z.coerce.number().int().positive().default(5),
  /** Sliding window (seconds) for the OTP issuance throttle. */
  OTP_REQUEST_WINDOW_SEC: z.coerce.number().int().positive().default(900),
  /** Dev only: fixed OTP (e.g. 123456). Logged in terminal until email is wired up. */
  OTP_DEV_FIXED_CODE: z.string().optional(),

  /** Max failed auth attempts (register, login, password reset, etc.) within 15-min window. */
  SENSITIVE_AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),

  SENSITIVE_AUTH_RATE_LIMIT_WINDOW_MINUTES: z.coerce
    .number()
    .int()
    .positive()
    .default(15),
  // DELETE_ACCOUNT_RATE_LIMIT_MAX removed 2026-08-12 — DELETE /auth/account is
  // no longer throttled. Leaving the variable set in a .env file is harmless;
  // nothing reads it.

  /** Max POST /auth/change-password attempts per hour per user. The endpoint
   *  verifies `currentPassword`, so an unthrottled one is an offline-speed
   *  password oracle for anyone holding a stolen access token. */
  CHANGE_PASSWORD_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5),

  /** Proxy hops to trust for rate limiting IP detection (0 = no proxy, 1+ = trust X-Forwarded-For). */
  TRUST_PROXY_HOPS: z.coerce.number().int().nonnegative().default(0),

  /** QR device-link session lifetime (seconds) — spec: 60s. */
  QR_LINK_TTL_SECONDS: z.coerce.number().int().positive().default(60),
  /** Max QR generation requests per minute per IP (spec: 5). */
  QR_GENERATION_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5),
  /** Max QR scan requests per minute per user/IP (spec: 10). */
  QR_SCAN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  /**
   * Extra seconds the Redis key survives PAST `expiresAt` so the expiry
   * sweeper (which ticks every QR_LINK_SWEEPER_INTERVAL_MS) has a window to
   * observe + atomically mark a still-PENDING/SCANNED session EXPIRED before
   * Redis's own TTL garbage-collects the key out from under it.
   */
  QR_LINK_SWEEP_GRACE_SECONDS: z.coerce.number().int().positive().default(30),
  QR_LINK_SWEEPER_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v !== "false"),
  QR_LINK_SWEEPER_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(30_000),

  /**
   * Google OAuth 2.0 client IDs (Google Cloud Console → Credentials), one per
   * mobile platform. Both are passed to `google-auth-library` as the accepted
   * `aud` array — the token is accepted if its `aud` claim matches either —
   * so the backend serves both apps without the client declaring its platform.
   *
   * Both optional; if BOTH are unset, Google login/link is disabled
   * (see lib/google-id-token.ts).
   */
  GOOGLE_OAUTH_APPLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_OAUTH_ANDROID_CLIENT_ID: z.string().min(1).optional(),

  /**
   * Comma-separated list of accepted Apple `aud` values — the Bundle ID(s)
   * (native Sign in with Apple) and/or Service ID(s) (web). Apple ID tokens
   * are verified against Apple's JWKS directly (see lib/apple-id-token.ts);
   * Firebase is not in the path.
   */
  APPLE_CLIENT_IDS: z.string().min(1).optional(),

  /**
   * Base URL of notifications-service. Used by the dev-only test push endpoint
   * to forward FCM token lists for delivery. Defaults to local dev.
   */
  NOTIFICATIONS_SERVICE_URL: z.string().url().default("http://localhost:3006"),

  /** chat-service gRPC address — used to update login-notification status on Terminate/Trust. */
  CHAT_SERVICE_GRPC_URL: z.string().min(1).default("localhost:4004"),

  /** backoffice-service gRPC address — used to reject emails already used by an admin account. */
  BACKOFFICE_GRPC_URL: z.string().min(1).default("localhost:4010"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid Environment Variables");
  console.error(parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;
