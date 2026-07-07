/**
 * Sets all env vars required by stream-service's `src/config/env.ts` (which
 * process.exit(1)s on a missing var) BEFORE any module is imported by tests.
 * dotenv does not override vars already set, so these win over any .env on disk.
 */
process.env.NODE_ENV = "test";
process.env.STREAM_SERVICE_PORT = "3007";
process.env.STREAM_GRPC_PORT = "4007";
process.env.STREAM_DATABASE_URL =
  "mongodb://test:test@localhost:27017/stream_test";
process.env.REDIS_HOST = "127.0.0.1";
process.env.REDIS_PORT = "6379";
process.env.REDIS_CACHE_ENABLED = "false";
process.env.JWT_ACCESS_SECRET = "test-access-secret-do-not-use-in-prod";
process.env.USER_GRPC_URL = "localhost:4002";
process.env.COMMUNITY_GRPC_URL = "localhost:4003";
process.env.SRS_HOOK_SECRET = "test-srs-hook-secret-do-not-use-in-prod";

export {};
