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

// Keep OTP deterministic if any code path reaches it under test.
process.env.OTP_DEV_FIXED_CODE = "123456";

export {};
