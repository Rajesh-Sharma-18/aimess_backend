/**
 * Runs in Jest `setupFiles` — BEFORE any service module is imported — so that
 * `src/config/env.ts` (which `process.exit(1)`s on a missing/invalid var) sees a
 * fully-populated, schema-valid environment. dotenv does not override vars that
 * are already set, so these win over any real `.env` on disk.
 *
 * Every key here is required (or explicitly exercised) by
 * `apps/community-service/src/config/env.ts`.
 */
process.env.NODE_ENV = "test";

process.env.COMMUNITY_SERVICE_PORT = "3003";
process.env.COMMUNITY_GRPC_PORT = "4003";

// gRPC peers (clients are mocked, but env must still parse).
process.env.CHAT_GRPC_URL = "0.0.0.0:4004";
process.env.USER_GRPC_URL = "0.0.0.0:4002";

// MongoDB (Prisma datasource) — never connected (client is mocked).
process.env.COMMUNITY_DATABASE_URL =
  "mongodb://localhost:27018/community_db_test?directConnection=true";

process.env.REDIS_HOST = "127.0.0.1";
process.env.REDIS_PORT = "6379";
process.env.REDIS_CACHE_ENABLED = "false";
process.env.REDIS_CACHE_NAME_AVAIL_TTL_SEC = "60";
process.env.REDIS_CACHE_NAME_TAKEN_TTL_SEC = "86400";

process.env.RABBITMQ_URL = "amqp://localhost:5672";

process.env.JWT_ACCESS_SECRET = "test-access-secret-do-not-use-in-prod";

// MinIO / S3 — storage clients are mocked, but env must validate (URLs, keys).
process.env.MINIO_ENDPOINT = "http://127.0.0.1:9000";
process.env.MINIO_PUBLIC_ENDPOINT = "";
process.env.MINIO_ACCESS_KEY = "test-minio-access-key";
process.env.MINIO_SECRET_KEY = "test-minio-secret-key";
process.env.MINIO_BUCKET_COMMUNITY = "aimess-community";
process.env.MINIO_BUCKET_AVATARS = "aimess-avatars";
process.env.MINIO_REGION = "us-east-1";
process.env.MINIO_PRESIGN_EXPIRES_IN = "900";
process.env.MINIO_IMAGE_VIEW_EXPIRES_IN = "3600";
process.env.MINIO_AVATAR_VIEW_EXPIRES_IN = "3600";
process.env.COMMUNITY_IMAGE_MAX_UPLOAD_BYTES = "5242880";

export {};
