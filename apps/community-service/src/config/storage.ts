import { createStorageClient, type StorageClient } from "@aimess/storage";

import { env } from "./env.js";

/** Shared MinIO/S3 client for the community-service. */
export const storageClient: StorageClient = createStorageClient({
  endpoint: env.MINIO_ENDPOINT,
  accessKey: env.MINIO_ACCESS_KEY,
  secretKey: env.MINIO_SECRET_KEY,
  region: env.MINIO_REGION,
});
