import type { StorageClient } from "./client.js";
import { buildObjectKey } from "./object-key.js";
import { createPresignedUploadUrl } from "./presign.js";
import { assertAllowedMime, assertFileSize } from "./validation.js";

/** Configuration for one uploadable resource type. */
export interface UploadTypeDef {
  bucket: string;
  keyPrefix: string;
  maxBytes: number;
  /** Allowed MIME type → file extension. */
  allowedMime: Record<string, string>;
}

export interface CreateUploadUrlParams {
  client: StorageClient;
  def: UploadTypeDef;
  contentType: string;
  contentLength: number;
  ownerId: string;
  expiresIn: number;
}

export interface UploadUrlResult {
  uploadUrl: string;
  objectKey: string;
  uploadExpiresIn: number;
  maxBytes: number;
  headers: { "Content-Type": string };
}

/**
 * Validates the upload, builds an owned object key, and returns a presigned PUT
 * envelope. Throws {@link StorageValidationError} (specific code) on validation
 * failure — callers map the code to their own HTTP error.
 */
export async function createUploadUrl(
  params: CreateUploadUrlParams
): Promise<UploadUrlResult> {
  const { client, def, contentType, contentLength, ownerId, expiresIn } =
    params;

  assertAllowedMime(contentType, Object.keys(def.allowedMime));
  assertFileSize(contentLength, def.maxBytes);

  const ext = def.allowedMime[contentType];
  const objectKey = buildObjectKey({
    prefix: def.keyPrefix,
    ownerId,
    ext,
  });

  const uploadUrl = await createPresignedUploadUrl({
    client,
    bucket: def.bucket,
    objectKey,
    contentType,
    expiresIn,
  });

  return {
    uploadUrl,
    objectKey,
    uploadExpiresIn: expiresIn,
    maxBytes: def.maxBytes,
    headers: { "Content-Type": contentType },
  };
}
