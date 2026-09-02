import { logger } from "@aimess/logger";
import dotenv from "dotenv";
import { z } from "zod";

import { expandFileSecrets } from "@aimess/utils";

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]),
  NOTIFICATIONS_SERVICE_PORT: z.coerce.number().positive(),
  NOTIFICATIONS_GRPC_PORT: z.coerce.number().positive().default(4006),

  REDIS_HOST: z.string(),
  REDIS_PORT: z.coerce.number(),
  // Optional so local dev against an unauthenticated Redis keeps working.
  // Required for any shared/remote Redis, which must not be left open.
  REDIS_PASSWORD: z.string().optional(),
  /**
   * Wrap the Redis connection in TLS. Off by default so a loopback or
   * private-network Redis is unchanged; set true wherever the connection leaves
   * the host, because the AUTH password and — since Redis pub/sub is the
   * realtime fan-out — every message body otherwise travel in cleartext.
   */
  REDIS_TLS: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  RABBITMQ_URL: z.string().min(1),

  // MongoDB — own device-token store. Provide a complete MONGO_DATABASE_URL OR
  // the MONGO_* parts (mirrors chat-service). Resolved below into a usable URL.
  MONGO_DATABASE_URL: z.string().optional(),
  MONGO_ROOT_USERNAME: z.string().min(1).optional(),
  MONGO_ROOT_PASSWORD: z.string().min(1).optional(),
  MONGO_DATABASE: z.string().min(1).optional(), // auth source (e.g. admin)
  MONGODB_PORT: z.coerce.number().positive().optional(),
  MONGO_HOST: z.string().default("localhost"),
  MONGO_DB_NAME: z.string().default("aimess_notifications"),

  // Outbound gRPC targets (host:port) for opossum-wrapped clients.
  USER_SERVICE_GRPC_URL: z.string().default("127.0.0.1:4002"),
  CHAT_SERVICE_GRPC_URL: z.string().default("127.0.0.1:4004"),
  COMMUNITY_SERVICE_GRPC_URL: z.string().default("127.0.0.1:4003"),

  // Cached notification-settings TTL (seconds).
  NOTIF_SETTINGS_CACHE_TTL_SEC: z.coerce.number().positive().default(300),

  // Stale device-token sweeper (jobs/device-token-sweeper.ts). 60 days is well
  // past the 7-day refresh-token lifetime, so a device that stopped signing in
  // is long dead by then, while an app that launches (or receives a push) even
  // once every two months keeps its registration.
  DEVICE_TOKEN_TTL_DAYS: z.coerce.number().positive().default(60),
  DEVICE_TOKEN_SWEEPER_INTERVAL_MS: z.coerce
    .number()
    .positive()
    .default(6 * 60 * 60 * 1000),

  // FCM TTL for an incoming-call push. Mirrors chat-service's
  // CALL_RINGING_TIMEOUT_SEC — a ring delivered after the call stopped ringing
  // is noise, so the push expires with the ringing window. Keep the two in sync.
  CALL_RINGING_TIMEOUT_SEC: z.coerce.number().positive().default(60),

  // Public origin of the web app (no trailing slash), e.g.
  // https://app.aimess.me. Used as the click target of a WEB push: Web Push
  // opens `webpush.fcm_options.link` itself, with no service-worker code
  // involved. Optional — unset simply means the notification has no link and
  // the SW's own click handler decides, which is today's behaviour.
  WEB_APP_BASE_URL: z
    .string()
    .url()
    .optional()
    .transform((v) => v?.replace(/\/+$/, "")),

  // JWT access secret — verifies device-registration requests.
  // `.min(32)`: was a bare `z.string()`, so an empty or one-character value
  // passed boot validation. The secret is shared with every other service, so a
  // weak value here is a platform-wide token-forgery primitive, not a local one.
  JWT_ACCESS_SECRET: z.preprocess(
    (v) => (v === "" ? undefined : v),
    // Optional so a deployment that has moved to the keypair can REMOVE
    // it entirely — which is the whole point of the migration. The boot
    // assertion below requires one of the two.
    z.string().min(32).optional()
  ),
  /**
   * RS256 public key that verifies access tokens (PEM).
   *
   * The platform-wide fix for one symmetric secret being copied into eight
   * services: with a keypair, auth-service alone holds the private half and is
   * the only process able to MINT a token, while every other service holds only
   * this public half, which is not a secret. A leak from any service other than
   * auth-service then discloses nothing that can forge a session.
   *
   * Optional during the migration — set it alongside JWT_ACCESS_SECRET and both
   * are accepted, so tokens signed before the switch keep verifying until they
   * expire. Supply it as JWT_ACCESS_PUBLIC_KEY_FILE to mount it as a file.
   */
  JWT_ACCESS_PUBLIC_KEY: z.string().optional(),
  /**
   * Reject access tokens that carry no `iss`/`aud`. Leave false until every
   * token minted before those claims existed has expired (one access-token
   * lifetime after deploying), then turn it on.
   */
  JWT_REQUIRE_ISSUER_AUDIENCE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  FIREBASE_PROJECT_ID: z.string(),
  FIREBASE_CLIENT_EMAIL: z.string(),
  FIREBASE_PRIVATE_KEY: z.string(),

  // APNs VoIP push (iOS call ringing) — token-based (.p8) auth.
  APNS_KEY_ID: z.string(),
  APNS_TEAM_ID: z.string(),
  APNS_BUNDLE_ID: z.string(),
  APNS_PRIVATE_KEY: z.string(),
  APNS_PRODUCTION: z.coerce.boolean().default(false),

  SMTP_HOST: z.string(),
  SMTP_PORT: z.coerce.number(),
  SMTP_USER: z.string(),
  SMTP_PASS: z.string(),
  SMTP_FROM: z.string(),
});

// `FOO_FILE=/run/secrets/foo` supplies `FOO`, so a secret can be a mounted
// file (Docker/Kubernetes secrets) instead of an environment variable that
// leaks through /proc, crash dumps, `docker inspect` and CI logs — and so
// rotation is replacing a file rather than editing .env on every host.
const parsed = envSchema.safeParse(expandFileSecrets(process.env));

if (!parsed.success) {
  logger.error("Invalid environment variables");
  logger.error(parsed.error.format());
  process.exit(1);
}

const data = parsed.data;

/**
 * Resolve the MongoDB connection URL: prefer a complete MONGO_DATABASE_URL,
 * otherwise compose it from the MONGO_* parts (mirrors chat-service).
 */
function resolveMongoUrl(): string {
  if (
    data.MONGO_DATABASE_URL &&
    /^mongodb(\+srv)?:\/\//.test(data.MONGO_DATABASE_URL)
  ) {
    return data.MONGO_DATABASE_URL;
  }

  if (
    data.MONGO_ROOT_USERNAME &&
    data.MONGO_ROOT_PASSWORD &&
    data.MONGODB_PORT
  ) {
    const user = encodeURIComponent(data.MONGO_ROOT_USERNAME);
    const pass = encodeURIComponent(data.MONGO_ROOT_PASSWORD);
    const authSource = data.MONGO_DATABASE ?? "admin";
    return (
      `mongodb://${user}:${pass}@${data.MONGO_HOST}:${String(data.MONGODB_PORT)}/` +
      `${data.MONGO_DB_NAME}?authSource=${authSource}&directConnection=true`
    );
  }

  logger.error(
    "Invalid Mongo config: provide a complete MONGO_DATABASE_URL, or the " +
      "MONGO_ROOT_USERNAME / MONGO_ROOT_PASSWORD / MONGODB_PORT parts."
  );
  process.exit(1);
}

export const env = {
  ...data,
  MONGO_DATABASE_URL: resolveMongoUrl(),
};

/**
 * How this service verifies access tokens.
 *
 * One object rather than a bare secret, because verification now has three
 * inputs: the legacy shared secret, the RS256 public key that replaces it, and
 * whether `iss`/`aud` are mandatory yet. Every call site takes this, so they
 * cannot drift apart — and so moving to a keypair is a configuration change
 * rather than a code change in each service.
 */
export const accessTokenVerifyConfig = {
  secret: env.JWT_ACCESS_SECRET,
  publicKey: env.JWT_ACCESS_PUBLIC_KEY,
  requireIssuerAudience: env.JWT_REQUIRE_ISSUER_AUDIENCE,
};

/**
 * Refuse to start with no way to verify a token at all.
 *
 * The schema cannot express "one of these two", and a service that boots
 * without either would reject every request — or, worse, a future refactor
 * could make it accept them unverified.
 */
if (!env.JWT_ACCESS_SECRET && !env.JWT_ACCESS_PUBLIC_KEY) {
  console.error(
    "Refusing to start: set JWT_ACCESS_PUBLIC_KEY (preferred) or JWT_ACCESS_SECRET — without one, no access token can be verified."
  );
  process.exit(1);
}
