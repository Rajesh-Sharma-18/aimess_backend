/**
 * The centralized structural-validation pipeline for every uploaded object.
 *
 * This is the ONE place that decides whether stored bytes are a safe, well-formed
 * instance of the type they claim to be. Every upload path — the REST
 * `/media/confirm`, the auto-confirm inside `/media/download-url`, the async
 * re-validation in the scan worker, and (via `validateStoredObject`) the
 * backoffice livestream-thumbnail commit — routes through `validateUpload` so a
 * new entry point cannot accidentally ship with a weaker policy.
 *
 * Order of operations, cheapest and most decisive first:
 *
 *   1. HeadObject — the object must exist, and its REAL size must be within the
 *      category/MIME cap. The presigned PUT signs only Content-Type, never
 *      Content-Length, so the size declared at upload-url time is advisory; this
 *      is the first point at which the true size is known, and it gates every
 *      later step that loads bytes into memory.
 *   2. Magic bytes on a 512-byte sample — cheap, and rejects the blunt "rename
 *      malware.exe to report.docx" case before anything larger is fetched.
 *   3. Deep structural inspection (`@aimess/storage` `inspectMedia`) — walks the
 *      format's own structure to confirm the WHOLE file is that format, and
 *      extracts the values the resource limits are enforced against: dimensions,
 *      pixel count, frame count, duration, and trailing (polyglot) bytes.
 *   4. ZIP-family structural inspection — bomb ratio, entry count, nested
 *      archives, encrypted entries, Zip-Slip names, and OOXML identification.
 *
 * The antivirus scan is NOT run here: it executes in the Bull media-scan worker
 * (scanner.ts) so it never blocks the request thread. Structural validation is
 * synchronous because it is bounded and because it is what decides whether the
 * object is even worth scanning.
 *
 * `declaredMime` MUST be a server-trusted value. Callers resolve it from the
 * MediaFile registry row (written at upload-url time) or from MinIO's stored
 * Content-Type (which the presigned PUT signature binds) — never from a request
 * body. See `resolveTrustedContentType` in media.service.ts.
 */

import { createHash } from "node:crypto";

import {
  assertMagicBytesMatch,
  MagicByteValidationError,
  MAGIC_BYTES_SAMPLE_SIZE,
  OOXML_MIME_TYPES,
  getObjectBytes,
  getObjectTailBytes,
  headObject,
  inspectMedia,
  needsCompleteBytes,
  type DeepInspectResult,
} from "@aimess/storage";
import {
  MEDIA_PROBE_BYTES,
  MEDIA_STRUCTURAL_LIMITS,
  type MediaRejectCode,
} from "@aimess/constants";

import { logger } from "@aimess/logger";

import { storageClient } from "../config/storage.js";
import {
  inspectZip,
  detectOoxmlType,
  detectOoxmlActiveContent,
  ZipInspectionError,
} from "./zip-inspector.js";

export type MagicValidationStatus = "CLEAN" | "REJECTED" | "ERROR";

export interface MagicValidationResult {
  status: MagicValidationStatus;
  /**
   * Machine-readable rejection reason. INTERNAL — persisted to the audit log and
   * `MediaFile.scanDetail`, never returned to a client. Clients receive only the
   * coarse `MEDIA_*` error codes, so detector internals (thresholds, offsets,
   * engine names) never leak. See docs/MEDIA_SECURITY_AUDIT.md §Error Handling.
   */
  rejectCode?: MediaRejectCode;
  /** Human-readable detail for the audit log. INTERNAL. */
  reason?: string;
  /** True file size in bytes from MinIO HeadObject. */
  fileSize?: number;
  /** Structural facts extracted during inspection (dimensions, duration, …). */
  inspection?: DeepInspectResult;
  /**
   * SHA-256 of the object, hex. Present only when the whole object was read
   * (images/PDFs/archives); container probes read a window, not the file, so
   * hashing there would produce a digest of a prefix — worse than none. The AV
   * worker always has the full bytes and fills this in for the rest.
   *
   * SHA-256 and not MD5: this is used for audit correlation and malware
   * investigation, where a collision is an attacker's goal, not an accident.
   */
  sha256?: string;
}

export interface MagicValidateParams {
  bucket: string;
  objectKey: string;
  /** SERVER-TRUSTED MIME. Never a client-supplied request field. */
  declaredMime: string;
  /**
   * Authoritative byte-size ceiling for this category+MIME — the SAME
   * `min(maxBytes, maxBytesByMime[mime])` enforced on the declared
   * Content-Length at upload-url time. Re-checked here against the real,
   * MinIO-reported size because the presigned PUT signs only Content-Type.
   */
  maxBytes: number;
}

/** MIME types requiring ZIP structural inspection (OOXML + plain ZIP). */
const ZIP_FAMILY_MIMES = new Set<string>([
  "application/zip",
  "application/x-zip-compressed",
  ...OOXML_MIME_TYPES,
]);

const rejected = (
  rejectCode: MediaRejectCode,
  reason: string,
  fileSize?: number
): MagicValidationResult => ({
  status: "REJECTED",
  rejectCode,
  reason,
  fileSize,
});

export async function validateUpload(
  params: MagicValidateParams
): Promise<MagicValidationResult> {
  const { bucket, objectKey, declaredMime, maxBytes } = params;

  // ── 1. Verify object exists ───────────────────────────────────────────────
  // "No bytes at the key" is a FAILED UPLOAD, not a verdict on content. Returning
  // REJECTED here made /media/confirm report a security rejection for an object
  // that was never fully PUT, and clients treat REJECTED as terminal (they delete
  // the upload). ERROR keeps the object PENDING and retriable, which is what a
  // half-finished PUT actually needs.
  const head = await headObject(storageClient, bucket, objectKey);
  if (!head.exists) {
    return {
      status: "ERROR",
      reason: "Object not found in storage — upload may have failed",
    };
  }
  const fileSize = head.contentLength ?? 0;
  if (fileSize <= 0) {
    return { status: "ERROR", reason: "Object is zero bytes", fileSize };
  }

  // ── 1b. Enforce the REAL size against the category/MIME cap ──────────────
  if (maxBytes > 0 && fileSize > maxBytes) {
    return rejected(
      "SIZE_EXCEEDED",
      `File size ${fileSize} exceeds the ${maxBytes}-byte limit for this type`,
      fileSize
    );
  }

  // ── 2. Fetch sample bytes for the magic-byte check ────────────────────────
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
      fileSize,
    };
  }

  // ── 3. Magic-byte validation ──────────────────────────────────────────────
  try {
    assertMagicBytesMatch(sampleBuf, declaredMime);
  } catch (err) {
    if (err instanceof MagicByteValidationError) {
      logger.warn("magic-byte mismatch — rejecting upload", {
        objectKey,
        declaredMime,
        detail: err.message,
      });
      return rejected("SIGNATURE_MISMATCH", err.message, fileSize);
    }
    throw err;
  }

  // ── 4. Deep structural inspection ─────────────────────────────────────────
  // Images and PDFs need the whole file (trailing-data detection is only
  // possible with the tail in hand, and they are capped small enough to hold in
  // memory). Audio/video containers are probed from a head window plus a tail
  // window so a non-faststart MP4 still yields its duration.
  const wantsComplete = needsCompleteBytes(declaredMime);
  if (wantsComplete && fileSize > MEDIA_PROBE_BYTES.maxInMemoryImage) {
    return rejected(
      "SIZE_EXCEEDED",
      `File of ${fileSize} bytes is too large to inspect in memory`,
      fileSize
    );
  }

  const head1 = wantsComplete
    ? await getObjectBytes(storageClient, bucket, objectKey)
    : await getObjectBytes(
        storageClient,
        bucket,
        objectKey,
        Math.min(fileSize, MEDIA_PROBE_BYTES.containerHead)
      );

  if (!head1 || head1.length === 0) {
    return {
      status: "ERROR",
      reason: "Could not read object bytes for structural inspection",
      fileSize,
    };
  }

  const complete = wantsComplete || head1.length >= fileSize;
  const tail =
    complete || fileSize <= MEDIA_PROBE_BYTES.containerHead
      ? undefined
      : ((await getObjectTailBytes(
          storageClient,
          bucket,
          objectKey,
          MEDIA_PROBE_BYTES.containerTail
        )) ?? undefined);

  const inspection = inspectMedia({
    head: head1,
    tail,
    totalSize: fileSize,
    declaredMime,
    complete,
    limits: MEDIA_STRUCTURAL_LIMITS,
  });

  if (!inspection.ok) {
    logger.warn("deep inspection failed — rejecting upload", {
      objectKey,
      declaredMime,
      code: inspection.code,
      detail: inspection.detail,
    });
    return rejected(
      inspection.code ?? "MALFORMED_CONTAINER",
      inspection.detail ?? "structural inspection failed",
      fileSize
    );
  }

  // (`inspectMedia` reconciles the format it identified from the STRUCTURE
  // against the declaration itself — see `assertDetectedMatchesDeclared` — so a
  // file wearing the right first bytes over a different format is already
  // rejected above with SIGNATURE_MISMATCH.)

  // ── 5. ZIP / OOXML structural inspection ──────────────────────────────────
  if (ZIP_FAMILY_MIMES.has(declaredMime)) {
    // Full file bytes are needed for the central-directory walk.
    const fullBuf = complete
      ? head1
      : await getObjectBytes(storageClient, bucket, objectKey);
    if (!fullBuf) {
      return {
        status: "ERROR",
        reason: "Could not fetch full ZIP bytes for inspection",
        fileSize,
      };
    }

    try {
      const entries = inspectZip(fullBuf, fileSize);

      if (OOXML_MIME_TYPES.has(declaredMime)) {
        // FAIL CLOSED. `null` means "this archive is not identifiable as any
        // OOXML package" — previously that was treated as "cannot tell, accept",
        // which let a plain ZIP through as a .docx.
        const detected = detectOoxmlType(entries);
        if (detected === null) {
          return rejected(
            "OOXML_TYPE_MISMATCH",
            `declared ${declaredMime} but the archive is not a recognisable OOXML package`,
            fileSize
          );
        }
        if (detected !== declaredMime) {
          return rejected(
            "OOXML_TYPE_MISMATCH",
            `OOXML type mismatch: declared ${declaredMime} but archive identifies as ${detected}`,
            fileSize
          );
        }
        const active = detectOoxmlActiveContent(entries);
        if (active) {
          return rejected(
            "SUSPICIOUS_CONTENT",
            `OOXML package contains active content: ${active}`,
            fileSize
          );
        }
      }
    } catch (err) {
      if (err instanceof ZipInspectionError) {
        logger.warn("ZIP inspection failed — rejecting upload", {
          objectKey,
          declaredMime,
          code: err.code,
          detail: err.message,
        });
        return rejected(err.code, err.message, fileSize);
      }
      throw err;
    }
  }

  // Structure CLEAN. The AV scan runs asynchronously in the Bull media-scan
  // worker — never inline on the request thread.
  return {
    status: "CLEAN",
    fileSize,
    inspection,
    sha256: complete ? sha256Of(head1) : undefined,
  };
}

/** Hex SHA-256 of a buffer. */
export function sha256Of(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}
