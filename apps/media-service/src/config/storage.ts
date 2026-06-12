import {
  createMediaUrlStrategy,
  createStorageClient,
  type StorageClient,
} from "@aimess/storage";

import { env } from "./env.js";

export const storageClient: StorageClient = createStorageClient({
  endpoint: env.MINIO_ENDPOINT,
  accessKey: env.MINIO_ACCESS_KEY,
  secretKey: env.MINIO_SECRET_KEY,
  region: env.MINIO_REGION,
});

export const presignClient: StorageClient = createStorageClient({
  endpoint: env.MINIO_PUBLIC_ENDPOINT ?? env.MINIO_ENDPOINT,
  accessKey: env.MINIO_ACCESS_KEY,
  secretKey: env.MINIO_SECRET_KEY,
  region: env.MINIO_REGION,
});

export const mediaUrlStrategy = createMediaUrlStrategy({
  client: presignClient,
  defaultViewExpiresIn: env.MINIO_VIEW_EXPIRES_IN,
  cdnBaseUrl: null,
});
