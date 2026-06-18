import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]),

  BACKOFFICE_SERVICE_PORT: z.coerce.number().positive().default(3010),
  BACKOFFICE_GRPC_PORT: z.coerce.number().positive().default(4010),

  ADMIN_DATABASE_URL: z.string().min(1),

  REDIS_HOST: z.string(),
  REDIS_PORT: z.coerce.number(),

  // Admin JWT — separate secret/lifetime from the user-facing access token.
  JWT_ADMIN_SECRET: z.string().min(1),
  /** Admin access-token lifetime in seconds (default 8h). */
  JWT_ADMIN_EXPIRES_IN: z.string().default("28800"),
  /** Admin opaque refresh-token lifetime in seconds (default 7d). */
  JWT_ADMIN_REFRESH_EXPIRES_IN: z.string().default("604800"),

  RABBITMQ_URL: z.string().min(1),

  // gRPC endpoints of the services the dashboard aggregates (live, read-only).
  AUTH_GRPC_URL: z.string().default("0.0.0.0:4001"),
  USER_GRPC_URL: z.string().default("0.0.0.0:4002"),
  COMMUNITY_GRPC_URL: z.string().default("0.0.0.0:4003"),
  CHAT_GRPC_URL: z.string().default("0.0.0.0:4004"),

  /**
   * Comma-separated CORS origin allowlist (e.g. the admin-panel URL). LAN /
   * loopback origins are auto-allowed in dev via a regex, so this is mainly for
   * production hosts. Empty is fine in dev.
   */
  CORS_ALLOWED_ORIGINS: z.string().default(""),

  /** Comma-separated allowlist; empty = allow all (dev). Enforced at gateway too. */
  ADMIN_IP_WHITELIST: z.string().default(""),
  /** Proxy hops to trust when deriving the client IP (0 = direct clients). */
  TRUST_PROXY_HOPS: z.coerce.number().int().nonnegative().default(0),

  ADMIN_RATE_LIMIT_WINDOW_MINUTES: z.coerce
    .number()
    .int()
    .positive()
    .default(15),
  ADMIN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  ADMIN_LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),

  // SMTP — direct OTP email delivery from the forgot-password flow. Optional
  // with MailHog-style defaults so the service boots without mail config; set
  // real provider creds (e.g. Gmail/SES) in .env to deliver to real inboxes.
  SMTP_HOST: z.string().default("localhost"),
  SMTP_PORT: z.coerce.number().default(1025),
  SMTP_USER: z.string().default(""),
  SMTP_PASS: z.string().default(""),
  SMTP_FROM: z.string().default("AIMess Admin <no-reply@aimess.local>"),

  // Bootstrap super-admin (seed). If unset, no admin is auto-created.
  BOOTSTRAP_SUPER_ADMIN_EMAIL: z.string().email().optional(),
  BOOTSTRAP_SUPER_ADMIN_PASSWORD: z.string().min(6).optional(),
  BOOTSTRAP_SUPER_ADMIN_NAME: z.string().default("Super Admin"),

  // Admin password-reset (OTP + reset token) tunables.
  ADMIN_OTP_LENGTH: z.coerce.number().int().positive().default(6),
  ADMIN_OTP_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  ADMIN_OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  ADMIN_OTP_REQUEST_MAX: z.coerce.number().int().positive().default(5),
  ADMIN_OTP_REQUEST_WINDOW_SEC: z.coerce.number().int().positive().default(900),
  ADMIN_OTP_RESEND_COOLDOWN_SEC: z.coerce.number().int().positive().default(60),
  ADMIN_PASSWORD_RESET_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(600),
  /** Dev-only fixed OTP code to skip email delivery while testing. */
  ADMIN_OTP_DEV_FIXED_CODE: z.string().optional(),

  /**
   * Base URL of the system default-avatar generator. A deterministic
   * `?seed=<admin>` is appended for admins without a custom avatar. Defaults to
   * DiceBear's keyless initials service; point at an internal CDN/generator in
   * prod by overriding this.
   */
  ADMIN_DEFAULT_AVATAR_BASE_URL: z
    .string()
    .url()
    .default("https://api.dicebear.com/9.x/initials/svg"),

  // =========================
  // MinIO — presign user-service avatar keys on the SHARED avatars bucket.
  // Backoffice does NOT own this bucket; it only signs GET URLs (presign-only,
  // no HEAD), mirroring community-service's member-avatar resolution.
  // =========================
  MINIO_ENDPOINT: z.string().url(),
  /**
   * Client-facing MinIO host used ONLY to sign view URLs. Falls back to
   * MINIO_ENDPOINT when unset (same-machine setups).
   */
  MINIO_PUBLIC_ENDPOINT: z.string().url().optional(),
  MINIO_ACCESS_KEY: z.string().min(1),
  MINIO_SECRET_KEY: z.string().min(1),
  MINIO_BUCKET_AVATARS: z.string().min(1).default("aimess-avatars"),
  // Community avatar/cover bucket (community-service owns the keys). Backoffice
  // only signs view URLs for it; the strategy resolves any bucket by name.
  MINIO_BUCKET_COMMUNITY: z.string().min(1).default("aimess-community"),
  MINIO_REGION: z.string().default("us-east-1"),
  /** Presigned GET lifetime for avatar display URLs (seconds). */
  MINIO_AVATAR_VIEW_EXPIRES_IN: z.coerce.number().positive().default(3600),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables");
  console.error(parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;

/** Origins for `cors` — comma-separated list from env. */
export function getCorsAllowedOrigins(): string[] {
  return env.CORS_ALLOWED_ORIGINS.split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}
