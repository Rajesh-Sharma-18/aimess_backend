import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]),

  AUTH_SERVICE_PORT: z.coerce.number(),

  AUTH_DATABASE_URL: z.string(),

  REDIS_HOST: z.string(),
  REDIS_PORT: z.coerce.number(),

  JWT_ACCESS_SECRET: z.string(),
  JWT_REFRESH_SECRET: z.string(),

  JWT_ACCESS_EXPIRES_IN: z.string(),
  JWT_REFRESH_EXPIRES_IN: z.string(),

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
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid Environment Variables");
  console.error(parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;
