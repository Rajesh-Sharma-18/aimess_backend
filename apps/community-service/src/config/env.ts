import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]),
  COMMUNITY_SERVICE_PORT: z.coerce.number().positive(),
  COMMUNITY_GRPC_PORT: z.coerce.number().positive().default(4003),

  /** chat-service gRPC endpoint — community-chat summaries for GET /communities/mine. */
  CHAT_GRPC_URL: z.string().default("0.0.0.0:4004"),

  COMMUNITY_DATABASE_URL: z.string(),

  REDIS_HOST: z.string(),
  REDIS_PORT: z.coerce.number(),
  REDIS_CACHE_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  /** Community name/handle availability cache TTL when available. */
  REDIS_CACHE_NAME_AVAIL_TTL_SEC: z.coerce.number().positive().default(60),
  /** Community name/handle taken / unavailable cache TTL. */
  REDIS_CACHE_NAME_TAKEN_TTL_SEC: z.coerce.number().positive().default(86_400),

  /** Reserved for future community events (publish/consume). */
  RABBITMQ_URL: z.string().min(1),

  /** Optional base URL used to build shareable community invite links. */
  INVITE_LINK_BASE_URL: z.string().url().optional(),

  USER_GRPC_URL: z.string().default("0.0.0.0:4002"),

  /** Same secret as auth-service — used to verify access tokens. */
  JWT_ACCESS_SECRET: z.string().min(1),

  MINIO_ENDPOINT: z.string().url(),
  /**
   * Client-facing MinIO host used ONLY to sign upload/view URLs.
   * Falls back to MINIO_ENDPOINT when unset (same-machine setups).
   */
  MINIO_PUBLIC_ENDPOINT: z.string().url().optional(),
  MINIO_ACCESS_KEY: z.string().min(1),
  MINIO_SECRET_KEY: z.string().min(1),
  MINIO_BUCKET_COMMUNITY: z.string().min(1),
  /** user-service's avatars bucket (shared MinIO) — used to presign member avatar GET URLs. */
  MINIO_BUCKET_AVATARS: z.string().min(1).default("aimess-avatars"),
  MINIO_REGION: z.string().default("us-east-1"),
  MINIO_PRESIGN_EXPIRES_IN: z.coerce.number().positive().default(900),
  /** Presigned GET lifetime for community image display URLs (seconds). */
  MINIO_IMAGE_VIEW_EXPIRES_IN: z.coerce.number().positive().default(3600),
  /** Presigned GET lifetime for member avatar display URLs (seconds). */
  MINIO_AVATAR_VIEW_EXPIRES_IN: z.coerce.number().positive().default(3600),
  /** Max community image (avatar/cover) file size in bytes (default 5 MB). */
  COMMUNITY_IMAGE_MAX_UPLOAD_BYTES: z.coerce
    .number()
    .positive()
    .max(20 * 1024 * 1024)
    .default(5 * 1024 * 1024),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables");
  console.error(parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;
