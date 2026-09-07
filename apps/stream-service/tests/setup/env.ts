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
// Pinned explicitly (matches the schema's own default) so tests are hermetic —
// without this, dotenv falls through to whatever `apps/stream-service/.env`
// happens to have on the machine running the suite (often "false" for local
// dev), silently changing which membership-gate branches tests exercise.
process.env.STREAM_REQUIRE_MEMBERSHIP = "true";
process.env.MINIO_ENDPOINT = "http://localhost:9000";
// The endpoint presigned URLs are actually built from, and the one MinIO var
// that was missed here — so a developer whose .env points MinIO at a LAN
// address (the documented setup for testing across devices) got that host back
// in every presigned avatar URL, and the broadcast-shape assertion failed on
// their machine and nowhere else.
process.env.MINIO_PUBLIC_ENDPOINT = "http://localhost:9000";
process.env.MINIO_ACCESS_KEY = "test-minio-access-key";
process.env.MINIO_SECRET_KEY = "test-minio-secret-key";
process.env.MINIO_BUCKET_AVATARS = "aimess-avatars";
process.env.MINIO_REGION = "us-east-1";

export {};
