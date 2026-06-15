import type { StorageClient } from "./client.js";
import { buildObjectKey } from "./object-key.js";
import { createPresignedUploadUrl } from "./presign.js";
import {
  assertAllowedMime,
  assertExtensionMatchesMime,
  assertFileSize,
  sanitizeFileName,
} from "./validation.js";

/** Configuration for one uploadable resource type. */
export interface UploadTypeDef {
  bucket: string;
  keyPrefix: string;
  /** Category ceiling — the hard maximum for any MIME in this category. */
  maxBytes: number;
  /** Allowed MIME type → file extension. */
  allowedMime: Record<string, string>;
  /**
   * Optional per-MIME byte cap. The effective limit enforced is
   * `min(maxBytes, maxBytesByMime[contentType])`, so a category can keep a high
   * ceiling (e.g. 100 MB video) while capping images far lower. MIMEs absent
   * from this map fall back to `maxBytes`.
   */
  maxBytesByMime?: Record<string, number>;
}

export interface CreateUploadUrlParams {
  client: StorageClient;
  def: UploadTypeDef;
  contentType: string;
  contentLength: number;
  ownerId: string;
  expiresIn: number;
  /** Optional client-declared original filename (display metadata only). */
  fileName?: string | null;
}

export interface UploadUrlResult {
  uploadUrl: string;
  objectKey: string;
  uploadExpiresIn: number;
  /** Effective byte cap actually enforced (per-MIME if set, else category). */
  maxBytes: number;
  headers: { "Content-Type": string };
  /** Sanitized original filename echoed back ("" when none/blank). */
  fileName?: string;
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

  const ext = def.allowedMime[contentType];

  // Sanitize the client filename before it is echoed back or used in a
  // Content-Disposition header, and reject a deceptive extension mismatch.
  const fileName = sanitizeFileName(params.fileName);
  if (fileName) {
    assertExtensionMatchesMime(fileName, ext);
  }

  // Effective cap: the smaller of the category ceiling and any per-MIME cap.
  const perMime = def.maxBytesByMime?.[contentType];
  const effectiveMax =
    perMime != null ? Math.min(def.maxBytes, perMime) : def.maxBytes;
  assertFileSize(contentLength, effectiveMax);

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
    maxBytes: effectiveMax,
    headers: { "Content-Type": contentType },
    fileName,
  };
}
