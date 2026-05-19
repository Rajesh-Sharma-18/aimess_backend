import { env } from "../config/env.js";

/**
 * MinIO/S3 buckets — one bucket per media class (policy, size, lifecycle).
 * Keys inside a bucket use prefixes from `ObjectKeyPrefix`.
 */
export const StorageBuckets = {
  /** Profile avatars — small images, optional public read. */
  avatars: env.MINIO_BUCKET_AVATARS,
} as const;

/** Object key prefixes (not bucket names). */
export const ObjectKeyPrefix = {
  avatars: "avatars",
  /** Future: chat attachments */
  chatImages: "chat/images",
  chatFiles: "chat/files",
  /** Future: voice notes */
  chatAudio: "chat/audio",
} as const;

export type StorageBucketId = keyof typeof StorageBuckets;
