import dotenv from "dotenv";
import { z } from "zod";

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
    JWT_ACCESS_SECRET: z.string().min(1),

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

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables");
  console.error(parsed.error.format());
  process.exit(1);
}

const raw = parsed.data;

export const env = {
  ...raw,
  MINIO_BUCKET_AVATARS: raw.MINIO_BUCKET_AVATARS ?? raw.MINIO_BUCKET!,
};
