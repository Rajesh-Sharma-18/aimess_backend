import {
  createMediaUrlStrategy,
  createStorageClient,
  type MediaUrlStrategy,
  type StorageClient,
} from "@aimess/storage";

import { env } from "./env.js";

/**
 * Client used ONLY to sign presigned view (GET) URLs for user avatars on the
 * SHARED MinIO avatars bucket — which backoffice does NOT own (user-service
 * produces the keys). Points at MINIO_PUBLIC_ENDPOINT when set, otherwise the
 * internal endpoint (equivalent on same-machine setups). No internal/HEAD
 * client is wired because avatar resolution is presign-only (no existence
 * check), mirroring community-service's member-avatar flow.
 */
export const presignClient: StorageClient = createStorageClient({
  endpoint: env.MINIO_PUBLIC_ENDPOINT ?? env.MINIO_ENDPOINT,
  accessKey: env.MINIO_ACCESS_KEY,
  secretKey: env.MINIO_SECRET_KEY,
  region: env.MINIO_REGION,
});

/**
 * Shared media-URL strategy backing the nested `avatar: MediaObject` fields.
 * Presign-only (no CDN base URL) so resolved download URLs are byte-identical
 * in shape to the legacy `avatarUrl`/`avatarUrlExpiresIn` presigned GETs.
 */
export const mediaUrlStrategy: MediaUrlStrategy = createMediaUrlStrategy({
  client: presignClient,
  defaultViewExpiresIn: env.MINIO_AVATAR_VIEW_EXPIRES_IN,
  cdnBaseUrl: null,
});
