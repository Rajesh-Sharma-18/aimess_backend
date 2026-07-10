import {
  createMediaUrlStrategy,
  createStorageClient,
  type MediaUrlStrategy,
  type StorageClient,
} from "@aimess/storage";

import { env } from "./env.js";

/**
 * Client used ONLY to sign presigned URLs a remote client will hit. Points at
 * MINIO_PUBLIC_ENDPOINT when set, otherwise falls back to the internal
 * endpoint (equivalent on same-machine setups). Mirrors chat-service's
 * presignClient — stream-service never uploads/deletes objects itself, it
 * only resolves stored avatar object keys to a viewable URL.
 */
export const presignClient: StorageClient = createStorageClient({
  endpoint: env.MINIO_PUBLIC_ENDPOINT ?? env.MINIO_ENDPOINT,
  accessKey: env.MINIO_ACCESS_KEY,
  secretKey: env.MINIO_SECRET_KEY,
  region: env.MINIO_REGION,
});

export const mediaUrlStrategy: MediaUrlStrategy = createMediaUrlStrategy({
  client: presignClient,
  defaultViewExpiresIn: env.MINIO_VIEW_EXPIRES_IN,
  cdnBaseUrl: null,
});
