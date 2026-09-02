/**
 * Runs in Jest `setupFiles` — BEFORE any service module is imported — so that
 * `src/config/env.ts` (which `process.exit(1)`s on a missing/invalid var) sees a
 * fully-populated, schema-valid environment. dotenv does not override vars that
 * are already set, so these win over any real `.env` on disk.
 */
process.env.NODE_ENV = "test";

process.env.AUTH_SERVICE_PORT = "3001";
process.env.AUTH_GRPC_PORT = "4001";
process.env.AUTH_DATABASE_URL =
  "postgresql://test:test@localhost:5432/aimess_auth_test?schema=public";

process.env.REDIS_HOST = "127.0.0.1";
process.env.REDIS_PORT = "6379";

process.env.JWT_ACCESS_SECRET = "test-access-secret-do-not-use-in-prod";
process.env.JWT_REFRESH_SECRET = "test-refresh-secret-do-not-use-in-prod";
process.env.JWT_ACCESS_EXPIRES_IN = "3600";
process.env.JWT_REFRESH_EXPIRES_IN = "604800";
process.env.JWT_REFRESH_EXPIRES_IN_REMEMBER_ME = "2592000";

process.env.CORS_ALLOWED_ORIGINS = "http://localhost:3000";
process.env.RABBITMQ_URL = "amqp://localhost:5672";

// Rate limiters are per-process, so a spec file firing many requests would trip
// the production ceiling. Specs that assert throttling set their own value
// before importing the app (see tests/account/change-password-rate-limit.test.ts).
// DELETE_ACCOUNT_RATE_LIMIT_MAX is gone — that endpoint is no longer throttled.
process.env.CHANGE_PASSWORD_RATE_LIMIT_MAX = "100";
// sensitiveAuthRateLimiter is per-IP and now mounted on login/register/social/
// forgot-password — every spec in this process shares one IP, so the production
// ceiling of 20 would 429 partway through the auth suites.
process.env.SENSITIVE_AUTH_RATE_LIMIT_MAX = "10000";

// Keep OTP deterministic if any code path reaches it under test.
process.env.OTP_DEV_FIXED_CODE = "123456";

export {};

// OTP issuance throttle.
//
// The whole suite runs in one process from one address, so it exceeds the
// production per-IP ceiling (5 per 15 min) many times over. That used to go
// unnoticed because the limiter failed fully open whenever Redis was
// unavailable — which it always is under the harness. Now that a cache failure
// degrades to a per-process counter instead of forfeiting the cap, the harness
// has to declare headroom like any other limiter it is not the subject of.
// The spec that tests the throttle sets its own values.
process.env.OTP_REQUEST_MAX = "100000";
