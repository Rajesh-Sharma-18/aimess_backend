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
  /**
   * Headers the PUT must carry. Both are part of the signature, so an upload
   * that omits or alters either is rejected by object storage rather than
   * silently accepted at a different size.
   */
  headers: { "Content-Type": string; "Content-Length": string };
  /** Sanitized original filename echoed back ("" when none/blank). */
  fileName?: string;
}

/**
 * Effective byte cap for a category+MIME pair: the smaller of the category
 * ceiling and any per-MIME cap. Shared by upload-time (declared Content-Length)
 * and confirm-time (actual MinIO-reported size) enforcement so the two can't
 * silently drift apart.
 */
export function effectiveMaxBytes(
  def: Pick<UploadTypeDef, "maxBytes" | "maxBytesByMime">,
  contentType: string
): number {
  const perMime = def.maxBytesByMime?.[contentType];
  return perMime != null ? Math.min(def.maxBytes, perMime) : def.maxBytes;
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
  const effectiveMax = effectiveMaxBytes(def, contentType);
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
    // Bind the declared size into the signature. `assertFileSize` above only
    // validated the NUMBER the client sent; without signing it, the URL still
    // accepted a body of any length.
    contentLength,
  });

  return {
    uploadUrl,
    objectKey,
    uploadExpiresIn: expiresIn,
    maxBytes: effectiveMax,
    // `Content-Length` is signed, so the PUT must carry exactly this value.
    // Returned explicitly rather than left implicit: a client that streams the
    // body without setting it will now be refused by object storage, and the
    // number it must send should not be something it has to infer.
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(contentLength),
    },
    fileName,
  };
}
