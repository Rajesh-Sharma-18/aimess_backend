import dotenv from "dotenv";
import { z } from "zod/v4";
import { logger } from "@aimess/logger";

dotenv.config();

const emptyToUndef = (v: unknown) => (v === "" ? undefined : v);

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  MEDIA_SERVICE_PORT: z.coerce.number().positive().default(3009),
  MEDIA_GRPC_PORT: z.coerce.number().positive().default(4009),

  JWT_ACCESS_SECRET: z.string().min(1),

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
  MINIO_PRESIGN_EXPIRES_IN: z.coerce.number().positive().default(900),
  MINIO_VIEW_EXPIRES_IN: z.coerce.number().positive().default(3600),

  AVATAR_MAX_UPLOAD_BYTES: z.coerce
    .number()
    .positive()
    .default(5 * 1024 * 1024),
  COMMUNITY_IMAGE_MAX_UPLOAD_BYTES: z.coerce
    .number()
    .positive()
    .default(5 * 1024 * 1024),
  CHAT_VIDEO_MAX_BYTES: z.coerce.number().positive().default(104857600),
  COMMUNITY_CHAT_MAX_BYTES: z.coerce.number().positive().default(104857600),
  GROUP_CHAT_MAX_BYTES: z.coerce.number().positive().default(104857600),

  // Redis — used for scan-status cache and rate-limit store
  REDIS_HOST: z.string().default("127.0.0.1"),
  REDIS_PORT: z.coerce.number().positive().default(6379),

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

  // Async media-scan worker knobs.
  MEDIA_SCAN_QUEUE_NAME: z.string().default("media-scan"),
  MEDIA_SCAN_CONCURRENCY: z.coerce.number().int().positive().default(2),
  MEDIA_SCAN_JOB_ATTEMPTS: z.coerce.number().int().positive().default(3),
  MEDIA_SCAN_BACKOFF_MS: z.coerce.number().int().positive().default(5000),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  logger.error("Invalid environment variables", {
    errors: parsed.error.format(),
  });
  process.exit(1);
}

export const env = parsed.data;
