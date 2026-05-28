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
   * Firebase Admin service-account credentials (Project Settings →
   * Service accounts → Generate new private key). Used to verify the
   * Firebase ID tokens sent by the Google / Apple sign-in clients.
   *
   * Optional so the service still boots without them — only Google/Apple
   * login is disabled until all three are set (see config/firebase.ts).
   */
  FIREBASE_PROJECT_ID: z.string().min(1).optional(),
  FIREBASE_CLIENT_EMAIL: z.string().min(1).optional(),
  FIREBASE_PRIVATE_KEY: z.string().min(1).optional(),

  /**
   * Google OAuth 2.0 Web client ID (Google Cloud Console → Credentials).
   * Used as the expected `aud` when verifying Google ID tokens sent by the
   * sign-in clients via `google-auth-library`.
   *
   * Optional so the service still boots without it — only Google login/link
   * is disabled until it is set (see lib/google-id-token.ts).
   */
  GOOGLE_OAUTH_CLIENT_ID: z.string().min(1).optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid Environment Variables");
  console.error(parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;
