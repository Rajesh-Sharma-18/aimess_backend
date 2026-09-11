/**
 * Runs in Jest `setupFiles` — BEFORE any service module is imported — so that
 * `src/config/env.ts` (which `process.exit(1)`s on a missing/invalid var) sees a
 * fully-populated, schema-valid environment. dotenv does not override vars that
 * are already set, so these win over any real `.env` on disk.
 *
 * Every key validated by chat-service's `src/config/env.ts` is set here with a
 * realistic dummy value. URL-typed vars (MINIO_*) must be valid URLs or Zod
 * rejects them and the env loader exits the process.
 */
process.env.NODE_ENV = "test";

// -- Service ports --
process.env.CHAT_SERVICE_PORT = "3004";
process.env.CHAT_GRPC_PORT = "4004";

// -- MongoDB (composed from parts → resolveMongoUrl()) --
process.env.MONGO_ROOT_USERNAME = "root";
process.env.MONGO_ROOT_PASSWORD = "rootpass";
process.env.MONGO_DATABASE = "admin";
process.env.MONGODB_PORT = "27018";
process.env.MONGO_HOST = "localhost";
process.env.MONGO_DB_NAME = "aimess_chat_test";

// -- Redis --
process.env.REDIS_HOST = "127.0.0.1";
process.env.REDIS_PORT = "6379";

// -- JWT (shared @aimess/auth-jwt verifies against this) --
process.env.JWT_ACCESS_SECRET = "test-access-secret-do-not-use-in-prod";

// -- LiveKit (required: no schema default) --
// Call join tokens are minted with this pair. The schema used to default it to
// a value published in the repo; now that it is required, the harness supplies
// it like any other mandatory var.
process.env.LIVEKIT_URL = "wss://test.livekit.cloud";
process.env.LIVEKIT_API_KEY = "test-livekit-key";
process.env.LIVEKIT_API_SECRET = "test-livekit-secret-do-not-use-in-prod";

// -- RabbitMQ (optional in schema, set for completeness) --
process.env.RABBITMQ_URL = "amqp://localhost:5672";

// -- MinIO / object storage (URL-typed → must be valid URLs) --
process.env.MINIO_ENDPOINT = "http://localhost:9000";
process.env.MINIO_PUBLIC_ENDPOINT = "http://localhost:9000";
process.env.MINIO_ACCESS_KEY = "minioadmin";
process.env.MINIO_SECRET_KEY = "minioadmin";
process.env.MINIO_BUCKET = "aimess-chat-test";
process.env.MINIO_REGION = "us-east-1";

// -- gRPC peer URLs (have schema defaults, set explicitly anyway) --
process.env.USER_SERVICE_GRPC_URL = "0.0.0.0:4002";
process.env.AUTH_GRPC_URL = "0.0.0.0:4001";
process.env.COMMUNITY_GRPC_URL = "0.0.0.0:4003";
process.env.COMMUNITY_ROOM_RECONCILE_ENABLED = "false";

export {};
