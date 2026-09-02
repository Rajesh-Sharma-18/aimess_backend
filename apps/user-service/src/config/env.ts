import dotenv from "dotenv";
import { z } from "zod";

import { assertNoPlaceholderCredentials, expandFileSecrets } from "@aimess/utils";

dotenv.config();

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "production", "test"]),
    USER_SERVICE_PORT: z.coerce.number().positive(),
    USER_GRPC_PORT: z.coerce.number().positive().default(4002),

    USER_DATABASE_URL: z.string(),

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
    REDIS_CACHE_ENABLED: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),
    /** Username availability (validate) cache TTL when available. */
    REDIS_CACHE_USERNAME_AVAIL_TTL_SEC: z.coerce
      .number()
      .positive()
      .default(60),
    /** Username taken / unavailable cache TTL. */
    REDIS_CACHE_USERNAME_TAKEN_TTL_SEC: z.coerce
      .number()
      .positive()
      .default(86_400),
    /** GET /profiles/me DB record cache TTL (avatar presign is always fresh). */
    REDIS_CACHE_PROFILE_TTL_SEC: z.coerce.number().positive().default(120),
    /** Cached auth account summary when auth-service is slow or down. */
    REDIS_CACHE_ACCOUNT_TTL_SEC: z.coerce.number().positive().default(300),

    RABBITMQ_URL: z.string().min(1),

    /** Same secret as auth-service — used to verify access tokens. */
    JWT_ACCESS_SECRET: z.preprocess(
      (v) => (v === "" ? undefined : v),
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

    AUTH_GRPC_URL: z.string().default("0.0.0.0:4001"),
    /** stream-service gRPC endpoint — force-ends a deleted account's active streams. */
    STREAM_GRPC_URL: z.string().default("0.0.0.0:4007"),
    /** chat-service gRPC endpoint — resolves rooms/groups for User Search. */
    CHAT_GRPC_URL: z.string().default("0.0.0.0:4004"),
    /**
     * community-service gRPC endpoint — resolves a community's active roster so
     * the "Add Members" picker can exclude people who are already in it.
     */
    COMMUNITY_GRPC_URL: z.string().default("0.0.0.0:4003"),
    /** media-service gRPC — avatar scan-verdict verification before persist. */
    MEDIA_GRPC_URL: z.string().default("0.0.0.0:4009"),
    /**
     * Master switch for the avatar verification gate. Default ON. Set false only
     * for a controlled rollout window against clients that do not yet call
     * `/media/confirm`; watch `media.attachment_unverified` to size the gap.
     */
    AVATAR_MEDIA_VERIFY_ENABLED: z
      .string()
      .default("true")
      .transform((v) => v !== "false"),

    MINIO_ENDPOINT: z.string().url(),
    /**
     * Client-facing MinIO host used ONLY to sign upload/view URLs.
     * Falls back to MINIO_ENDPOINT when unset (same-machine setups).
     */
    MINIO_PUBLIC_ENDPOINT: z.preprocess(
      (v) => (v === "" ? undefined : v),
      z.string().url().optional()
    ),
    MINIO_ACCESS_KEY: z.string().min(1),
    MINIO_SECRET_KEY: z.string().min(1),
    /** @deprecated Use MINIO_BUCKET_AVATARS. Kept for existing .env files. */
    MINIO_BUCKET: z.string().min(1).optional(),
    MINIO_BUCKET_AVATARS: z.string().min(1).optional(),
    MINIO_REGION: z.string().default("us-east-1"),
    /** Presigned PUT lifetime for upload URLs (seconds). */
    MINIO_PRESIGN_EXPIRES_IN: z.coerce.number().positive().default(900),
    /** Presigned GET lifetime for avatar display URLs (seconds). */
    MINIO_AVATAR_VIEW_EXPIRES_IN: z.coerce.number().positive().default(3600),
    /** Max avatar file size in bytes (default 5 MB). */
    AVATAR_MAX_UPLOAD_BYTES: z.coerce
      .number()
      .positive()
      .max(20 * 1024 * 1024)
      .default(5 * 1024 * 1024),
    /** Timeout (ms) for outbound HTTP calls to auth-service. */
    AUTH_SERVICE_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),
  })
  .refine((data) => Boolean(data.MINIO_BUCKET_AVATARS ?? data.MINIO_BUCKET), {
    message: "Set MINIO_BUCKET_AVATARS or MINIO_BUCKET",
    path: ["MINIO_BUCKET_AVATARS"],
  });

// `FOO_FILE=/run/secrets/foo` supplies `FOO`, so a secret can be a mounted
// file (Docker/Kubernetes secrets) instead of an environment variable that
// leaks through /proc, crash dumps, `docker inspect` and CI logs — and so
// rotation is replacing a file rather than editing .env on every host.
const expanded = expandFileSecrets(process.env);
const parsed = envSchema.safeParse(expanded);

if (!parsed.success) {
  console.error("Invalid environment variables");
  console.error(parsed.error.format());
  process.exit(1);
}

const raw = parsed.data;

// Refuse to start a production deployment whose credentials are values
// published in this repository. The schema can see that a string is present and
// long enough; it cannot see that everyone already knows what it says. Matched
// by variable NAME shape, so a secret added tomorrow is covered without anyone
// remembering to extend a list.
try {
  assertNoPlaceholderCredentials(expanded, {
    nodeEnv: raw.NODE_ENV,
    serviceName: "user-service",
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}


export const env = {
  ...raw,
  MINIO_BUCKET_AVATARS: raw.MINIO_BUCKET_AVATARS ?? raw.MINIO_BUCKET!,
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
