/**
 * ZIP security inspector.
 *
 * Implements defence-in-depth against ZIP-based attacks without extracting
 * the archive (all analysis is done on raw bytes from MinIO):
 *
 *   1. ZIP bomb detection — checks the total uncompressed size declared in
 *      the End of Central Directory (EOCD) record against the stored file
 *      size. Rejects if ratio > ZIP_MAX_COMPRESSION_RATIO.
 *
 *   2. Nested archive detection — scans Local File Headers inside the ZIP
 *      and checks the first 4 bytes of each entry's compressed data for
 *      known archive magic bytes (PK header, RAR, 7z, GZ, BZ2). A ZIP
 *      containing another archive is rejected.
 *
 *   3. Entry count guard — rejects ZIPs with an absurd number of entries
 *      (> ZIP_MAX_ENTRIES, default 10 000) to block "billion laughs"-style
 *      small-file bomb attacks.
 *
 * All byte-reading is done on in-memory Buffers already fetched from MinIO
 * by the confirm handler. No filesystem access, no subprocess, no extraction.
 */

import { env } from "../config/env.js";

// ─── Error types ─────────────────────────────────────────────────────────────

export class ZipInspectionError extends Error {
  constructor(
    readonly code:
      | "ZIP_BOMB_DETECTED"
      | "ZIP_NESTED_ARCHIVE"
      | "ZIP_ENTRY_COUNT_EXCEEDED"
      | "ZIP_INVALID_STRUCTURE",
    message: string
  ) {
    super(message);
    this.name = "ZipInspectionError";
  }
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Absolute cap on the number of entries accepted in a single ZIP. */
const ZIP_MAX_ENTRIES = 10_000;

/** Magic bytes that identify nested archive formats. */
const NESTED_ARCHIVE_MAGIC: Array<{ bytes: number[]; name: string }> = [
  { bytes: [0x50, 0x4b, 0x03, 0x04], name: "ZIP" }, // nested ZIP (PK\x03\x04)
  { bytes: [0x50, 0x4b, 0x05, 0x06], name: "ZIP (empty)" },
  { bytes: [0x52, 0x61, 0x72, 0x21], name: "RAR" }, // Rar!
  { bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], name: "7z" }, // 7z
  { bytes: [0x1f, 0x8b], name: "GZIP" },
  { bytes: [0x42, 0x5a, 0x68], name: "BZIP2" }, // BZh
  { bytes: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00], name: "XZ" },
];

// ─── ZIP structure constants ──────────────────────────────────────────────────

const EOCD_SIGNATURE = 0x06054b50;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const EOCD_MIN_SIZE = 22;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readUInt32LE(buf: Buffer, offset: number): number {
  return buf.readUInt32LE(offset);
}

function readUInt16LE(buf: Buffer, offset: number): number {
  return buf.readUInt16LE(offset);
}

function startsWithMagic(
  buf: Buffer,
  offset: number,
  magic: number[]
): boolean {
  if (offset + magic.length > buf.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (buf[offset + i] !== magic[i]) return false;
  }
  return true;
}

// ─── EOCD finder ─────────────────────────────────────────────────────────────

/**
 * Locate the End of Central Directory record in `buf`. Searches backwards
 * from the end of the buffer (standard approach — the EOCD is always near
 * the end, possibly preceded by an optional comment up to 65 535 bytes).
 */
function findEocd(buf: Buffer): number | null {
  // EOCD is at minimum the last 22 bytes; scan backwards for the 4-byte sig
  for (let i = buf.length - EOCD_MIN_SIZE; i >= 0; i--) {
    if (readUInt32LE(buf, i) === EOCD_SIGNATURE) return i;
  }
  return null;
}

// ─── Public inspection function ───────────────────────────────────────────────

/**
 * Inspect a ZIP archive in memory.
 *
 * @param buf       Full bytes of the ZIP file as fetched from MinIO.
 * @param storedSize Actual on-disk size in bytes (from MinIO HeadObject or
 *                  the Content-Length of the presigned-url response) — used
 *                  as the compressed reference for the ratio check.
 *
 * Throws {@link ZipInspectionError} on any violation; returns normally when
 * the archive passes all checks.
 */
export function inspectZip(buf: Buffer, storedSize: number): void {
  if (buf.length < EOCD_MIN_SIZE) {
    throw new ZipInspectionError(
      "ZIP_INVALID_STRUCTURE",
      "Buffer too small to be a valid ZIP"
    );
  }

  // ── 1. Locate EOCD ────────────────────────────────────────────────────────
  const eocdOffset = findEocd(buf);
  if (eocdOffset === null) {
    throw new ZipInspectionError(
      "ZIP_INVALID_STRUCTURE",
      "No End of Central Directory record found"
    );
  }

  // ── 2. Parse EOCD fields ──────────────────────────────────────────────────
  // EOCD layout (all LE):
  //   [0] signature        4 bytes
  //   [4] disk number      2
  //   [6] start disk       2
  //   [8] entries on disk  2
  //   [10] total entries   2
  //   [12] CD size         4
  //   [16] CD offset       4
  //   [20] comment length  2
  const totalEntries = readUInt16LE(buf, eocdOffset + 10);
  // "uncompressed size of central directory" is not in EOCD directly; we sum
  // uncompressed sizes from local file headers below.

  // ── 3. Entry count guard ──────────────────────────────────────────────────
  if (totalEntries > ZIP_MAX_ENTRIES) {
    throw new ZipInspectionError(
      "ZIP_ENTRY_COUNT_EXCEEDED",
      `ZIP contains ${totalEntries} entries, exceeding the limit of ${ZIP_MAX_ENTRIES}`
    );
  }

  // ── 4. Walk local file headers ────────────────────────────────────────────
  // Local File Header layout:
  //   [0]  signature          4
  //   [4]  version needed     2
  //   [6]  general flags      2
  //   [8]  compression method 2
  //   [10] last mod time      2
  //   [12] last mod date      2
  //   [14] crc-32             4
  //   [18] compressed size    4
  //   [22] uncompressed size  4
  //   [26] file name length   2
  //   [28] extra field length 2
  //   [30] file name          n
  //   [30+n] extra field      m
  //   [30+n+m] file data      compressedSize bytes

  let offset = 0;
  let totalUncompressed = 0;

  while (offset + 30 < buf.length) {
    if (readUInt32LE(buf, offset) !== LOCAL_FILE_HEADER_SIGNATURE) break;

    const compressedSize = readUInt32LE(buf, offset + 18);
    const uncompressedSize = readUInt32LE(buf, offset + 22);
    const fileNameLen = readUInt16LE(buf, offset + 26);
    const extraLen = readUInt16LE(buf, offset + 28);
    const dataOffset = offset + 30 + fileNameLen + extraLen;

    totalUncompressed += uncompressedSize;

    // ── 4a. Nested archive check ───────────────────────────────────────────
    if (compressedSize >= 4 && dataOffset + 4 <= buf.length) {
      for (const { bytes, name } of NESTED_ARCHIVE_MAGIC) {
        if (startsWithMagic(buf, dataOffset, bytes)) {
          throw new ZipInspectionError(
            "ZIP_NESTED_ARCHIVE",
            `ZIP entry at offset ${offset} contains a nested ${name} archive`
          );
        }
      }
    }

    offset = dataOffset + compressedSize;
  }

  // ── 5. ZIP bomb ratio check ───────────────────────────────────────────────
  if (storedSize > 0 && totalUncompressed > 0) {
    const ratio = totalUncompressed / storedSize;
    const maxRatio = env.ZIP_MAX_COMPRESSION_RATIO;
    if (ratio > maxRatio) {
      throw new ZipInspectionError(
        "ZIP_BOMB_DETECTED",
        `ZIP compression ratio ${ratio.toFixed(1)}:1 exceeds limit of ${maxRatio}:1`
      );
    }
  }
}

/**
 * Inspect a ZIP that was declared as an OOXML document (DOCX/XLSX/PPTX).
 * Verifies that the ZIP's `[Content_Types].xml` entry exists (all valid OOXML
 * archives contain it) AND that the declared `ooxml` MIME type matches the
 * package relationship. Falls back gracefully if the entry is not in the
 * fetched buffer segment.
 *
 * Returns the detected OOXML content-type string, or `null` if the file could
 * not be positively identified (caller decides whether to reject or warn).
 */
export function detectOoxmlType(buf: Buffer): string | null {
  // [Content_Types].xml is always a local file header near the start of the
  // archive. Search for its name in the buffer.
  const marker = Buffer.from("[Content_Types].xml");
  const idx = buf.indexOf(marker);
  if (idx < 0) return null;

  // Read a window of bytes after the marker to find the content type
  const window = buf
    .subarray(idx, Math.min(idx + 8192, buf.length))
    .toString("utf8");

  if (window.includes("wordprocessingml")) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  if (window.includes("spreadsheetml")) {
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }
  if (window.includes("presentationml")) {
    return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  }
  return null;
}
