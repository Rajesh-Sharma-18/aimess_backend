/**
 * Post-upload magic-byte + structural validation pipeline.
 *
 * Called by the /media/confirm endpoint after the client has PUT the file to
 * MinIO. Downloads the minimum bytes needed for analysis (full bytes only for
 * ZIP-family structural inspection), then:
 *
 *   1. Asserts the object actually exists in MinIO (headObject).
 *   2. Fetches first MAGIC_BYTES_SAMPLE_SIZE bytes (via Range GET).
 *   3. Validates file signature against the declared MIME type.
 *   4. For OOXML types (DOCX/XLSX/PPTX): verifies internal content-type.
 *   5. For ZIP / OOXML (ZIP family): runs ZIP bomb + nested-archive inspection.
 *
 * This module performs STRUCTURAL validation only. The antivirus scan is NOT
 * run here — it executes asynchronously in the Bull media-scan worker
 * (scanner.ts) so it never blocks the request thread.
 *
 * Returns a MagicValidationResult with status and optional detail.
 */

import {
  assertMagicBytesMatch,
  MagicByteValidationError,
  MAGIC_BYTES_SAMPLE_SIZE,
  OOXML_MIME_TYPES,
  getObjectBytes,
  headObject,
} from "@aimess/storage";

import { logger } from "@aimess/logger";

import { storageClient } from "../config/storage.js";
import {
  inspectZip,
  detectOoxmlType,
  ZipInspectionError,
} from "./zip-inspector.js";

export type MagicValidationStatus =
  | "CLEAN"
  | "REJECTED"
  | "QUARANTINED"
  | "ERROR";

export interface MagicValidationResult {
  status: MagicValidationStatus;
  /** Human-readable reason (not exposed to clients; written to audit log). */
  reason?: string;
  /** True file size in bytes from MinIO HeadObject. */
  fileSize?: number;
}

export interface MagicValidateParams {
  bucket: string;
  objectKey: string;
  declaredMime: string;
}

/**
 * MIME types whose archives require both magic-byte AND ZIP structural
 * inspection (OOXML + plain ZIP).
 */
const ZIP_FAMILY_MIMES = new Set<string>([
  "application/zip",
  "application/x-zip-compressed",
  ...OOXML_MIME_TYPES,
]);

export async function validateUpload(
  params: MagicValidateParams
): Promise<MagicValidationResult> {
  const { bucket, objectKey, declaredMime } = params;

  // ── 1. Verify object exists ───────────────────────────────────────────────
  const head = await headObject(storageClient, bucket, objectKey);
  if (!head.exists) {
    return {
      status: "REJECTED",
      reason: "Object not found in storage — upload may have failed",
    };
  }
  const fileSize = head.contentLength ?? 0;

  // ── 2. Fetch sample bytes for magic-byte check ────────────────────────────
  const sampleBuf = await getObjectBytes(
    storageClient,
    bucket,
    objectKey,
    MAGIC_BYTES_SAMPLE_SIZE
  );

  if (!sampleBuf || sampleBuf.length === 0) {
    return {
      status: "ERROR",
      reason: "Could not read object bytes from storage",
    };
  }

  // ── 3. Magic-byte validation ──────────────────────────────────────────────
  try {
    assertMagicBytesMatch(sampleBuf, declaredMime);
  } catch (err) {
    if (err instanceof MagicByteValidationError) {
      logger.warn("Magic-byte mismatch — rejecting upload", {
        objectKey,
        declaredMime,
        detail: err.message,
      });
      return {
        status: "REJECTED",
        reason: err.message,
        fileSize,
      };
    }
    throw err;
  }

  // ── 4 & 5. ZIP / OOXML structural inspection ──────────────────────────────
  if (ZIP_FAMILY_MIMES.has(declaredMime)) {
    // Full file bytes needed for EOCD scan and nested-archive walk.
    const fullBuf = await getObjectBytes(storageClient, bucket, objectKey);
    if (!fullBuf) {
      return {
        status: "ERROR",
        reason: "Could not fetch full ZIP bytes for inspection",
      };
    }

    try {
      inspectZip(fullBuf, fileSize);
    } catch (err) {
      if (err instanceof ZipInspectionError) {
        logger.warn("ZIP inspection failed — rejecting upload", {
          objectKey,
          declaredMime,
          code: err.code,
          detail: err.message,
        });
        return {
          status: "REJECTED",
          reason: `${err.code}: ${err.message}`,
          fileSize,
        };
      }
      throw err;
    }

    // OOXML: verify the declared Office type matches the archive's content
    if (OOXML_MIME_TYPES.has(declaredMime)) {
      const detected = detectOoxmlType(fullBuf);
      if (detected !== null && detected !== declaredMime) {
        logger.warn("OOXML content-type mismatch — rejecting upload", {
          objectKey,
          declaredMime,
          detected,
        });
        return {
          status: "REJECTED",
          reason: `OOXML type mismatch: declared ${declaredMime} but archive identifies as ${detected}`,
          fileSize,
        };
      }
    }

    // Structure passed. The AV scan runs asynchronously in the Bull media-scan
    // worker (scanner.ts) — never inline on the request thread.
    return { status: "CLEAN", fileSize };
  }

  // ── 6. AV scan deferred ───────────────────────────────────────────────────
  // Non-ZIP types have no further structural inspection. The AV scan runs
  // asynchronously in the Bull media-scan worker — not on the request thread.
  return { status: "CLEAN", fileSize };
}
