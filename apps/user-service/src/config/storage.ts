import { createStorageClient, type StorageClient } from "@aimess/storage";

import { env } from "./env.js";

/**
 * Internal MinIO/S3 client for the user-service — used for server→MinIO ops
 * (head, delete, ensureBuckets). Points at the internal MINIO_ENDPOINT.
 */
export const storageClient: StorageClient = createStorageClient({
  endpoint: env.MINIO_ENDPOINT,
  accessKey: env.MINIO_ACCESS_KEY,
  secretKey: env.MINIO_SECRET_KEY,
  region: env.MINIO_REGION,
});

/**
 * Client used ONLY to sign presigned URLs (upload PUT + view GET) that a
 * remote client will hit. Points at MINIO_PUBLIC_ENDPOINT when set, otherwise
 * falls back to the internal endpoint (equivalent on same-machine setups).
 */
export const presignClient: StorageClient = createStorageClient({
  endpoint: env.MINIO_PUBLIC_ENDPOINT ?? env.MINIO_ENDPOINT,
  accessKey: env.MINIO_ACCESS_KEY,
  secretKey: env.MINIO_SECRET_KEY,
  region: env.MINIO_REGION,
});
