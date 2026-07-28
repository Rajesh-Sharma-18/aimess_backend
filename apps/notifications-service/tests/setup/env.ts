/**
 * Runs in Jest `setupFiles` — BEFORE any service module is imported — so that
 * `src/config/env.ts` (which `process.exit(1)`s on a missing/invalid var) sees a
 * fully-populated, schema-valid environment. dotenv does not override vars that
 * are already set, so these win over any real `.env` on disk.
 *
 * Every key here is validated by `src/config/env.ts`. A complete
 * MONGO_DATABASE_URL is provided so `resolveMongoUrl()` short-circuits without
 * needing the MONGO_* parts (and never reaches its `process.exit(1)`).
 */
process.env.NODE_ENV = "test";

process.env.NOTIFICATIONS_SERVICE_PORT = "3006";
process.env.NOTIFICATIONS_GRPC_PORT = "4006";

process.env.REDIS_HOST = "127.0.0.1";
process.env.REDIS_PORT = "6379";

process.env.RABBITMQ_URL = "amqp://localhost:5672";

// Device-token store (MongoDB). A complete URL short-circuits resolveMongoUrl().
process.env.MONGO_DATABASE_URL =
  "mongodb://test:test@localhost:27017/aimess_notifications_test?authSource=admin&directConnection=true";

// Outbound gRPC targets (have defaults, set explicitly for clarity).
process.env.USER_SERVICE_GRPC_URL = "127.0.0.1:4002";
process.env.CHAT_SERVICE_GRPC_URL = "127.0.0.1:4004";

process.env.NOTIF_SETTINGS_CACHE_TTL_SEC = "300";

// JWT access secret — verifies device-registration requests (and mints test tokens).
process.env.JWT_ACCESS_SECRET = "test-access-secret-do-not-use-in-prod";

// Firebase Admin credentials — validated as plain strings by env.ts.
process.env.FIREBASE_PROJECT_ID = "test-firebase-project";
process.env.FIREBASE_CLIENT_EMAIL = "test@test.iam.gserviceaccount.com";
process.env.FIREBASE_PRIVATE_KEY =
  "-----BEGIN PRIVATE KEY-----\\ntest\\n-----END PRIVATE KEY-----\\n";

// APNs VoIP push (iOS call ringing). apn.Provider validates this as a real
// ES256 (P-256) key at construction time (unlike firebase-admin's lazy
// validation), so this must be an actual EC key — not an opaque placeholder
// string. Test-only key, generated with:
//   openssl ecparam -name prime256v1 -genkey -noout
process.env.APNS_KEY_ID = "TESTKEYID1";
process.env.APNS_TEAM_ID = "TESTTEAMID";
process.env.APNS_BUNDLE_ID = "com.aimess.test";
process.env.APNS_PRIVATE_KEY =
  "-----BEGIN EC PRIVATE KEY-----\\n" +
  "MHcCAQEEIB4GlYgNhuRyFt2Tc/RO5sDgL2lmiIpGCUcyedTlSq2doAoGCCqGSM49\\n" +
  "AwEHoUQDQgAEMfZunlU8YI4XaSHYKT0c5rlqR/gd0PCn5mN7S3jUTxXeqN0/1cja\\n" +
  "qsuOoIt/RIMEa3KkaUsKjuor/nVBpRvg7w==\\n" +
  "-----END EC PRIVATE KEY-----\\n";
process.env.APNS_PRODUCTION = "false";

// SMTP (mail provider).
process.env.SMTP_HOST = "localhost";
process.env.SMTP_PORT = "1025";
process.env.SMTP_USER = "test";
process.env.SMTP_PASS = "test";
process.env.SMTP_FROM = "AIMess <no-reply@aimess.test>";

export {};
