/**
 * Sets all env vars required by community-service's `src/config/env.ts` (which
 * process.exit(1)s on a missing var) BEFORE any module is imported by tests.
 * dotenv does not override vars already set, so these win over any .env on disk.
 */
process.env.NODE_ENV = "test";
process.env.COMMUNITY_SERVICE_PORT = "3003";
process.env.COMMUNITY_GRPC_PORT = "4003";
process.env.COMMUNITY_DATABASE_URL =
  "postgresql://test:test@localhost:5432/community_test";
process.env.REDIS_HOST = "127.0.0.1";
process.env.REDIS_PORT = "6379";
process.env.REDIS_CACHE_ENABLED = "false";
process.env.RABBITMQ_URL = "amqp://guest:guest@localhost:5672";
process.env.JWT_ACCESS_SECRET = "test-access-secret-do-not-use-in-prod";
process.env.MINIO_ENDPOINT = "http://localhost:9000";
process.env.MINIO_ACCESS_KEY = "minioadmin";
process.env.MINIO_SECRET_KEY = "minioadmin";
process.env.MINIO_BUCKET_COMMUNITY = "aimess-communities";
process.env.CHAT_GRPC_URL = "localhost:4004";
process.env.STREAM_GRPC_URL = "localhost:4007";
process.env.USER_GRPC_URL = "localhost:4002";

export {};
