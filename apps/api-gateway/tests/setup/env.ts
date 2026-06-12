/**
 * Runs in Jest `setupFiles` — BEFORE any service module is imported — so that
 * `src/config/env.ts` (which `process.exit(1)`s on a missing/invalid var) sees a
 * fully-populated, schema-valid environment. dotenv does not override vars that
 * are already set, so these win over any real `.env` on disk.
 *
 * Only the vars WITHOUT a default in `src/config/env.ts` are strictly required;
 * the rest are set with realistic dummy values for completeness/determinism.
 */
process.env.NODE_ENV = "test";

// --- Core (required, no schema default) -----------------------------------
process.env.API_GATEWAY_PORT = "8000";
process.env.AUTH_SERVICE_URL = "http://localhost:3001";
process.env.REDIS_URL = "redis://127.0.0.1:6379";
process.env.CORS_ALLOWED_ORIGINS = "http://localhost:3000";

// --- gRPC URLs for socket-facing services (required: .min(1)) -------------
process.env.MESSAGING_GRPC_URL = "localhost:4004";
process.env.COMMUNITY_GRPC_URL = "localhost:4003";
process.env.NOTIFICATION_GRPC_URL = "localhost:4006";

// --- JWT (access required for socket auth; admin optional but used by helper) -
process.env.JWT_ACCESS_SECRET = "test-access-secret-do-not-use-in-prod";
process.env.JWT_ADMIN_SECRET = "test-admin-secret-do-not-use-in-prod";

// --- Optional downstream service URLs (registry mounts proxies when present) -
process.env.USER_SERVICE_URL = "http://localhost:3002";
process.env.COMMUNITY_SERVICE_URL = "http://localhost:3003";
process.env.CHAT_SERVICE_URL = "http://localhost:3004";
process.env.NOTIFICATION_SERVICE_URL = "http://localhost:3006";
process.env.BACKOFFICE_SERVICE_URL = "http://localhost:3010";

// --- Optional gRPC URLs ----------------------------------------------------
process.env.AUTH_GRPC_URL = "localhost:4001";
process.env.USER_GRPC_URL = "localhost:4002";

export {};
