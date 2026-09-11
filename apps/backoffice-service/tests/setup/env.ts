/**
 * Runs in Jest `setupFiles` — BEFORE any service module is imported — so that
 * `src/config/env.ts` (which `process.exit(1)`s on a missing/invalid var) sees a
 * fully-populated, schema-valid environment. dotenv does not override vars that
 * are already set, so these win over any real `.env` on disk.
 *
 * Mirrors every field validated by apps/backoffice-service/src/config/env.ts.
 * Defaulted fields are still set explicitly where realistic, but only the
 * `.min(1)` / required ones are strictly necessary.
 */
process.env.NODE_ENV = "test";

process.env.BACKOFFICE_SERVICE_PORT = "3010";
process.env.BACKOFFICE_GRPC_PORT = "4010";

process.env.ADMIN_DATABASE_URL =
  "postgresql://test:test@localhost:5432/aimess_admin_test?schema=public";

process.env.REDIS_HOST = "127.0.0.1";
process.env.REDIS_PORT = "6379";

// Admin JWT — separate secret/lifetime from the user-facing access token.
process.env.JWT_ADMIN_SECRET = "test-admin-secret-do-not-use-in-prod";
process.env.JWT_ADMIN_EXPIRES_IN = "28800";
process.env.JWT_ADMIN_REFRESH_EXPIRES_IN = "604800";

process.env.RABBITMQ_URL = "amqp://localhost:5672";

// gRPC endpoints of aggregated services (clients are mocked; never dialed).
process.env.AUTH_GRPC_URL = "0.0.0.0:4001";
process.env.USER_GRPC_URL = "0.0.0.0:4002";
process.env.COMMUNITY_GRPC_URL = "0.0.0.0:4003";
process.env.CHAT_GRPC_URL = "0.0.0.0:4004";

process.env.CORS_ALLOWED_ORIGINS = "http://localhost:3000";

process.env.ADMIN_IP_WHITELIST = "";
process.env.TRUST_PROXY_HOPS = "0";

// The admin edge limiters now run inside this service too (they used to exist
// only at the gateway, which the dedicated admin vhost bypasses entirely). The
// whole suite shares one process and one IP, so it would otherwise exhaust the
// production ceilings partway through and fail unrelated specs with 429s.
// Raised here, and pinned to a deterministic low value by the spec that
// actually tests the limiter (tests/auth/edge-guards.test.ts), which re-imports
// the app with its own values.
process.env.ADMIN_RATE_LIMIT_WINDOW_MINUTES = "15";
process.env.ADMIN_RATE_LIMIT_MAX = "100000";
process.env.ADMIN_LOGIN_RATE_LIMIT_MAX = "100000";

// SMTP — defaults are MailHog-style; mailer seam is mocked anyway.
process.env.SMTP_HOST = "localhost";
process.env.SMTP_PORT = "1025";
process.env.SMTP_USER = "";
process.env.SMTP_PASS = "";
process.env.SMTP_FROM = "AIMess Admin <no-reply@aimess.local>";

// Admin password-reset (OTP + reset token) tunables.
process.env.ADMIN_OTP_LENGTH = "6";
process.env.ADMIN_OTP_TTL_SECONDS = "300";
process.env.ADMIN_OTP_MAX_ATTEMPTS = "5";
process.env.ADMIN_OTP_REQUEST_MAX = "5";
process.env.ADMIN_OTP_REQUEST_WINDOW_SEC = "900";
process.env.ADMIN_OTP_RESEND_COOLDOWN_SEC = "60";
process.env.ADMIN_PASSWORD_RESET_TOKEN_TTL_SECONDS = "600";
// Keep OTP deterministic if any code path reaches it under test.
process.env.ADMIN_OTP_DEV_FIXED_CODE = "123456";

process.env.ADMIN_DEFAULT_AVATAR_BASE_URL =
  "https://api.dicebear.com/9.x/initials/svg";

// MinIO — storage client/config is mocked; values only satisfy env validation.
process.env.MINIO_ENDPOINT = "http://localhost:9000";
process.env.MINIO_PUBLIC_ENDPOINT = "http://localhost:9000";
process.env.MINIO_ACCESS_KEY = "test-access-key";
process.env.MINIO_SECRET_KEY = "test-secret-key";
process.env.MINIO_BUCKET_AVATARS = "aimess-avatars";
process.env.MINIO_REGION = "us-east-1";
process.env.MINIO_AVATAR_VIEW_EXPIRES_IN = "3600";

// LiveKit — read only by the infra health probe, which is mocked in tests.
process.env.LIVEKIT_URL = "wss://test.livekit.cloud";

export {};
