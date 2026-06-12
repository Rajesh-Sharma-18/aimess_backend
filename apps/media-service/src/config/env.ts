import dotenv from "dotenv";
import { z } from "zod/v4";

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
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables");
  console.error(parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;
