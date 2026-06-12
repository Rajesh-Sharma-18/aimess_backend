/**
 * Runs in Jest `setupFiles` — BEFORE any service module is imported — so that
 * `src/config/env.ts` (which `process.exit(1)`s on a missing/invalid var) sees a
 * fully-populated, schema-valid environment. dotenv does not override vars that
 * are already set, so these win over any real `.env` on disk.
 *
 * Every key below is required (or refined) by `src/config/env.ts`. Values are
 * realistic dummies; nothing here touches real infrastructure under test.
 */
process.env.NODE_ENV = "test";

process.env.USER_SERVICE_PORT = "3002";
process.env.USER_GRPC_PORT = "4002";

process.env.USER_DATABASE_URL =
  "postgresql://test:test@localhost:5432/aimess_users_test?schema=public";

process.env.REDIS_HOST = "127.0.0.1";
process.env.REDIS_PORT = "6379";
process.env.REDIS_CACHE_ENABLED = "false";

process.env.RABBITMQ_URL = "amqp://localhost:5672";

// Same secret auth-service signs access tokens with; tests mint matching tokens.
process.env.JWT_ACCESS_SECRET = "test-access-secret-do-not-use-in-prod";

process.env.AUTH_GRPC_URL = "0.0.0.0:4001";

// MinIO / S3 presign config (URL-validated by env.ts).
process.env.MINIO_ENDPOINT = "http://localhost:9000";
process.env.MINIO_PUBLIC_ENDPOINT = "http://localhost:9000";
process.env.MINIO_ACCESS_KEY = "test-access-key";
process.env.MINIO_SECRET_KEY = "test-secret-key";
process.env.MINIO_BUCKET_AVATARS = "aimess-avatars-test";
process.env.MINIO_REGION = "us-east-1";

export {};
