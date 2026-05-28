import { env } from "./env.js";

/**
 * Upload type registry — one entry per uploadable resource. Each entry defines
 * the target bucket, object-key prefix, max size, and the allowed MIME types
 * mapped to their file extension.
 */
export const UPLOAD_TYPES = {
  AVATAR: {
    bucket: env.MINIO_BUCKET_AVATARS,
    keyPrefix: "avatars",
    maxBytes: env.AVATAR_MAX_UPLOAD_BYTES,
    allowedMime: {
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/webp": "webp",
    },
  },
} as const;

export type UploadType = keyof typeof UPLOAD_TYPES;
