import { assertNoPlaceholderCredentials, expandFileSecrets } from "@aimess/utils";
import dotenv from "dotenv";
import { z } from "zod/v4";
import { logger } from "@aimess/logger";

dotenv.config();

const emptyToUndef = (v: unknown) => (v === "" ? undefined : v);

const envSchema = z.object({
  // Required, with no default — matching the other services. A defaulted
  // "development" meant a dropped variable silently selected development
  // behaviour (including the permissive CORS default below) in a production
  // container, with nothing logged.
  NODE_ENV: z.enum(["development", "production", "test"]),
  MEDIA_SERVICE_PORT: z.coerce.number().positive().default(3009),
  MEDIA_GRPC_PORT: z.coerce.number().positive().default(4009),

  // chat-service gRPC (MessagingService.CheckMediaAccess) — used to authorize
  // chat-scoped attachment downloads against room/group/community membership.
  CHAT_GRPC_URL: z.string().default("127.0.0.1:4004"),

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
  // Optional: when set, upload-url/confirm/etc. also accept a backoffice
  // admin access token (same secret backoffice-service signs with) so admin
  // uploads (e.g. USER_AVATAR for an admin's own profile) reuse this flow
  // instead of a duplicate one. Unset in deployments that don't need it.
  JWT_ADMIN_SECRET: z.preprocess(emptyToUndef, z.string().min(32).optional()),

  CORS_ALLOWED_ORIGINS: z.string().default("*"),

  MINIO_ENDPOINT: z.string().url(),
  MINIO_PUBLIC_ENDPOINT: z.preprocess(
    emptyToUndef,
    z.string().url().optional()
  ),
  MINIO_ACCESS_KEY: z.string().min(1),
  MINIO_SECRET_KEY: z.string().min(1),
  MINIO_REGION: z.string().default("us-east-1"),
  MINIO_BUCKET_AVATARS: z.string().min(1),
  MINIO_BUCKET_COMMUNITY: z.string().min(1),
  MINIO_BUCKET: z.string().min(1),
  // Livestream thumbnails. backoffice-service uploads into this bucket and no
  // service was provisioning it (`ensureBuckets` was never called with it), so
  // it also never received the CORS rules a browser presigned PUT needs.
  MINIO_BUCKET_STREAM: z.string().min(1).default("aimess-stream"),
  MINIO_PRESIGN_EXPIRES_IN: z.coerce.number().positive().default(900),
  MINIO_VIEW_EXPIRES_IN: z.coerce.number().positive().default(604800),

  AVATAR_MAX_UPLOAD_BYTES: z.coerce
    .number()
    .positive()
    .default(5 * 1024 * 1024),
  COMMUNITY_IMAGE_MAX_UPLOAD_BYTES: z.coerce
    .number()
    .positive()
    .default(5 * 1024 * 1024),
  // Matches backoffice-service's STREAM_THUMBNAIL_UPLOAD_DEF ceiling.
  STREAM_THUMBNAIL_MAX_BYTES: z.coerce
    .number()
    .positive()
    .default(5 * 1024 * 1024),
  CHAT_VIDEO_MAX_BYTES: z.coerce.number().positive().default(104857600),
  COMMUNITY_CHAT_MAX_BYTES: z.coerce.number().positive().default(104857600),
  GROUP_CHAT_MAX_BYTES: z.coerce.number().positive().default(104857600),
  // Per-MIME overrides for the chat-attachment categories below (see
  // config/uploads.ts CHAT_MAX_BYTES_BY_MIME). Same var names + defaults as
  // chat-service's env (config/env.ts) so the presigned-upload-time guard
  // here and the message-send-time guard there can never silently drift
  // apart — see @aimess/constants media/limits.ts.
  CHAT_IMAGE_MAX_BYTES: z.coerce.number().positive().default(26214400), // 25 MB
  CHAT_AUDIO_MAX_BYTES: z.coerce.number().positive().default(26214400), // 25 MB
  CHAT_DOCUMENT_MAX_BYTES: z.coerce.number().positive().default(26214400), // 25 MB

  // Redis — used for scan-status cache and rate-limit store
  REDIS_HOST: z.string().default("127.0.0.1"),
  REDIS_PORT: z.coerce.number().positive().default(6379),
  // Optional so local dev against an unauthenticated Redis keeps working.
  // Required for any shared/remote Redis, which must not be left open.
  // Also used for the Bull connection below unless BULL_REDIS_PASSWORD is set.
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

  // ClamAV antivirus scanner
  // .default() is placed before .transform() so the default value is a string
  // ("false") that then passes through the transform to produce `false` (boolean).
  CLAMAV_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v === "true"),
  CLAMAV_HOST: z.string().default("127.0.0.1"),
  CLAMAV_PORT: z.coerce.number().positive().default(3310),
  CLAMAV_SCAN_TIMEOUT_MS: z.coerce.number().positive().default(30000),

  // ZIP security — maximum allowed uncompressed:compressed ratio before
  // the archive is classified as a ZIP bomb and rejected.
  ZIP_MAX_COMPRESSION_RATIO: z.coerce.number().positive().default(100),

  // Scan-status TTL: how long a CLEAN/QUARANTINED status is cached in Redis
  // before a re-confirm is required (seconds). Default 7 days.
  SCAN_STATUS_TTL_SECONDS: z.coerce
    .number()
    .positive()
    .default(7 * 24 * 60 * 60),

  // Bull queue Redis — Bull needs its OWN connection (blocking clients require
  // maxRetriesPerRequest:null), so it cannot reuse the shared @aimess/redis
  // singleton. Defaults to the same Redis as REDIS_HOST/PORT.
  BULL_REDIS_HOST: z.string().default("127.0.0.1"),
  BULL_REDIS_PORT: z.coerce.number().positive().default(6379),
  // Only set this when Bull points at a DIFFERENT Redis than REDIS_HOST.
  // Left unset, the Bull connection falls back to REDIS_PASSWORD (see
  // lib/scanner.ts), so the common single-Redis deployment needs one variable.
  BULL_REDIS_PASSWORD: z.string().optional(),

  // Async media-scan worker knobs.
  MEDIA_SCAN_QUEUE_NAME: z.string().default("media-scan"),
  MEDIA_SCAN_CONCURRENCY: z.coerce.number().int().positive().default(2),
  MEDIA_SCAN_JOB_ATTEMPTS: z.coerce.number().int().positive().default(3),
  MEDIA_SCAN_BACKOFF_MS: z.coerce.number().int().positive().default(5000),

  // MongoDB (media_db) — the MediaFile registry. Provide EITHER a complete
  // MONGO_DATABASE_URL, OR the MONGO_* parts below (the URL is composed from
  // them). Mirrors chat-service so the running Mongo replica set is reused.
  MONGO_ROOT_USERNAME: z.string().min(1).optional(),
  MONGO_ROOT_PASSWORD: z.string().min(1).optional(),
  MONGO_DATABASE: z.string().min(1).optional(), // auth source (where root user lives)
  MONGODB_PORT: z.coerce.number().positive().optional(),
  MONGO_HOST: z.string().default("localhost"),
  MONGO_DB_NAME: z.string().default("aimess_media"), // database holding media records
});

// `FOO_FILE=/run/secrets/foo` supplies `FOO`, so a secret can be a mounted
// file (Docker/Kubernetes secrets) instead of an environment variable that
// leaks through /proc, crash dumps, `docker inspect` and CI logs — and so
// rotation is replacing a file rather than editing .env on every host.
const expanded = expandFileSecrets(process.env);
const parsed = envSchema.safeParse(expanded);

if (!parsed.success) {
  logger.error("Invalid environment variables", {
    errors: parsed.error.format(),
  });
  process.exit(1);
}

const data = parsed.data;

// Refuse to start a production deployment whose credentials are values
// published in this repository. The schema can see that a string is present and
// long enough; it cannot see that everyone already knows what it says. Matched
// by variable NAME shape, so a secret added tomorrow is covered without anyone
// remembering to extend a list.
try {
  assertNoPlaceholderCredentials(expanded, {
    nodeEnv: data.NODE_ENV,
    serviceName: "media-service",
  });
} catch (error) {
  logger.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}


/**
 * Resolve the MongoDB connection URL: prefer a complete MONGO_DATABASE_URL,
 * otherwise compose it from the MONGO_* parts. Exits with a clear message if
 * neither is usable. Mirrors chat-service so the same running replica set works.
 */
function resolveMongoUrl(): string {
  const preBuilt = process.env.MONGO_DATABASE_URL;
  if (preBuilt && /^mongodb(\+srv)?:\/\/[^@/]+/.test(preBuilt)) {
    return preBuilt;
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
      `mongodb://${user}:${pass}@${data.MONGO_HOST}:${data.MONGODB_PORT}/` +
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

/**
 * Production invariant: the antivirus scanner must actually be running.
 *
 * With CLAMAV_ENABLED=false, `createScanner()` returns the no-op scanner and
 * `/media/confirm` writes the scan status `SKIPPED` inline. Everything
 * downstream — the download-URL gate and chat-service's send-time attachment
 * guard — then treats the object as servable, so an executable or macro-laden
 * document is fanned out to every recipient with a working download URL and no
 * inspection at all, while the docs and env comments present the platform as
 * AV-scanned. The flag stays for local development; production must not boot
 * without a scanner.
 */
if (env.NODE_ENV === "production" && !env.CLAMAV_ENABLED) {
  logger.error(
    "Refusing to start: CLAMAV_ENABLED=false is not permitted in production — " +
      "uploads would be stored and served with no malware inspection."
  );
  process.exit(1);
}
