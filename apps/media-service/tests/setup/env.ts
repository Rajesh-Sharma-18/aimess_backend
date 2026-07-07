/**
 * Runs in Jest `setupFiles` — BEFORE any service module is imported — so
 * `src/config/env.ts` sees a fully-populated, schema-valid environment.
 */
process.env.NODE_ENV = "test";

process.env.MEDIA_SERVICE_PORT = "3009";
process.env.MEDIA_GRPC_PORT = "4009";

process.env.JWT_ACCESS_SECRET = "test-access-secret-do-not-use-in-prod";

process.env.CORS_ALLOWED_ORIGINS = "*";

process.env.MINIO_ENDPOINT = "http://localhost:9000";
process.env.MINIO_PUBLIC_ENDPOINT = "http://localhost:9000";
process.env.MINIO_ACCESS_KEY = "test-access-key";
process.env.MINIO_SECRET_KEY = "test-secret-key";
process.env.MINIO_REGION = "us-east-1";
process.env.MINIO_BUCKET_AVATARS = "aimess-avatars-test";
process.env.MINIO_BUCKET_COMMUNITY = "aimess-community-test";
process.env.MINIO_BUCKET = "aimess-chat-test";
process.env.MINIO_PRESIGN_EXPIRES_IN = "900";
process.env.MINIO_VIEW_EXPIRES_IN = "3600";

process.env.AVATAR_MAX_UPLOAD_BYTES = String(5 * 1024 * 1024);
process.env.COMMUNITY_IMAGE_MAX_UPLOAD_BYTES = String(5 * 1024 * 1024);
process.env.CHAT_VIDEO_MAX_BYTES = String(104857600);
process.env.COMMUNITY_CHAT_MAX_BYTES = String(104857600);
process.env.CHAT_IMAGE_MAX_BYTES = String(26214400);
process.env.CHAT_AUDIO_MAX_BYTES = String(26214400);
process.env.CHAT_DOCUMENT_MAX_BYTES = String(26214400);

export {};
