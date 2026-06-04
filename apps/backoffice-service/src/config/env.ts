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
  JWT_ADMIN_REFRESH_SECRET: z.string().min(1),
  /** Admin refresh-token lifetime in seconds (default 7d). */
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
