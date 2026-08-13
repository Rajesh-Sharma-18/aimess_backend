/**
 * ZIP security inspector.
 *
 * Defence-in-depth against ZIP-based attacks WITHOUT extracting the archive —
 * all analysis is done on raw bytes already fetched from MinIO. No filesystem
 * access, no subprocess, no decompression.
 *
 * ── Why this reads the CENTRAL DIRECTORY, not the local file headers ─────────
 *
 * The previous implementation walked Local File Headers and trusted the sizes
 * it found there. Three things make that unsound, and all three were live
 * bypasses:
 *
 *   1. **Data descriptors.** When general-purpose flag bit 3 is set — which any
 *      streaming writer sets, and an attacker sets on purpose — the local header
 *      carries `compressedSize = 0, uncompressedSize = 0` and the real values
 *      live in a trailing descriptor. The bomb-ratio check summed zeros, saw
 *      `totalUncompressed === 0`, and skipped itself.
 *   2. **Walk desynchronisation.** With those sizes zeroed, `offset += 0` landed
 *      the walk inside compressed data, the signature test failed, and the loop
 *      `break`-ed after the first entry — so a 10 000-entry bomb was inspected
 *      one entry deep.
 *   3. **Compression method.** Nested-archive detection compared the first bytes
 *      of the entry's *compressed* payload against archive magic numbers. A
 *      nested ZIP stored with DEFLATE (the default) does not start with `PK`, so
 *      detection only ever worked against uncompressed nesting.
 *
 * The central directory is the archive's own authoritative index: it always
 * carries the true sizes, the compression method, the flags and the entry name,
 * for every entry, uncompressed. Reading it removes all three bypasses at once
 * and makes the name-based checks (path traversal, OOXML identification) possible.
 *
 * ── Checks performed ─────────────────────────────────────────────────────────
 *
 *   1. EOCD located and cross-validated against the central-directory offset and
 *      size it declares, so a second EOCD appended after the real one cannot
 *      forge the entry count.
 *   2. ZIP64 end-of-central-directory record honoured when the 32-bit fields
 *      hold the 0xFFFFFFFF sentinel.
 *   3. Entry count capped (`ZIP_MAX_ENTRIES`).
 *   4. Total uncompressed size vs stored size capped (`ZIP_MAX_COMPRESSION_RATIO`)
 *      and capped in absolute terms (`ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES`), which
 *      catches a bomb that stays under the ratio by padding.
 *   5. Nested archives rejected by ENTRY NAME extension — method-independent,
 *      unlike a magic-byte peek at compressed data.
 *   6. Encrypted entries rejected: their contents are unreadable by this
 *      inspector *and* by the downstream AV scanner, so accepting one means
 *      shipping an unscannable payload with a "scanned" label on it.
 *   7. Entry names checked for path traversal / absolute paths / NUL bytes
 *      (Zip-Slip). Nothing here extracts, but the archive is served on to
 *      clients that do.
 */

import { env } from "../config/env.js";

// ─── Error types ─────────────────────────────────────────────────────────────

export class ZipInspectionError extends Error {
  constructor(
    readonly code:
      | "ZIP_BOMB_DETECTED"
      | "ZIP_NESTED_ARCHIVE"
      | "ZIP_ENTRY_COUNT_EXCEEDED"
      | "ZIP_INVALID_STRUCTURE"
      | "ZIP_PATH_TRAVERSAL"
      | "ZIP_ENCRYPTED_ENTRY",
    message: string
  ) {
    super(message);
    this.name = "ZipInspectionError";
  }
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Absolute cap on the number of entries accepted in a single ZIP. */
const ZIP_MAX_ENTRIES = 10_000;

/**
 * Absolute ceiling on total uncompressed bytes, independent of the ratio.
 * A bomb can hold the ratio under the limit by shipping incompressible padding;
 * this is the backstop that makes the expansion cost bounded either way.
 */
const ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB

/**
 * Extensions that identify a nested archive. Checked against the entry NAME
 * from the central directory, so it holds regardless of compression method —
 * the flaw in peeking at the compressed payload's first bytes.
 */
const NESTED_ARCHIVE_EXTENSIONS = new Set([
  "zip",
  "rar",
  "7z",
  "gz",
  "tgz",
  "bz2",
  "xz",
  "lz",
  "lzma",
  "z",
  "cab",
  "arj",
  "iso",
  "jar",
  "war",
  "ear",
  "apk",
]);

/** Extensions that must never travel inside a document archive. */
const EXECUTABLE_EXTENSIONS = new Set([
  "exe",
  "dll",
  "scr",
  "com",
  "bat",
  "cmd",
  "pif",
  "vbs",
  "vbe",
  "js",
  "jse",
  "ws",
  "wsf",
  "wsh",
  "ps1",
  "psm1",
  "msi",
  "msp",
  "hta",
  "cpl",
  "jar",
  "lnk",
  "reg",
  "scf",
  "sh",
  "app",
  "dmg",
  "so",
  "dylib",
]);

// ─── ZIP structure constants ──────────────────────────────────────────────────

const EOCD_SIGNATURE = 0x06054b50;
const EOCD64_SIGNATURE = 0x06064b50;
const EOCD64_LOCATOR_SIGNATURE = 0x07064b50;
const CENTRAL_FILE_HEADER_SIGNATURE = 0x02014b50;
const EOCD_MIN_SIZE = 22;
const ZIP64_SENTINEL_32 = 0xffffffff;
const ZIP64_SENTINEL_16 = 0xffff;

/** General-purpose bit flags we care about. */
const FLAG_ENCRYPTED = 0x0001;
const FLAG_STRONG_ENCRYPTION = 0x0040;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const u16 = (buf: Buffer, at: number): number => buf.readUInt16LE(at);
const u32 = (buf: Buffer, at: number): number => buf.readUInt32LE(at);

/** 64-bit little-endian read as a JS number (safe: ZIP sizes stay < 2^53). */
function u64(buf: Buffer, at: number): number {
  return buf.readUInt32LE(at) + buf.readUInt32LE(at + 4) * 0x1_0000_0000;
}

interface EocdInfo {
  totalEntries: number;
  centralDirectorySize: number;
  centralDirectoryOffset: number;
}

/**
 * Locate and validate the End of Central Directory record.
 *
 * Scanning backwards finds the LAST EOCD signature, which is what a real reader
 * does — but on its own that lets an attacker append a forged 22-byte EOCD
 * claiming `totalEntries = 1` and sail past the entry-count guard. So every
 * candidate is validated: its declared central-directory offset and size must
 * land inside the buffer AND point at a real central-file-header signature. The
 * first candidate that survives is the real one.
 */
function findEocd(buf: Buffer): EocdInfo {
  for (let i = buf.length - EOCD_MIN_SIZE; i >= 0; i--) {
    if (u32(buf, i) !== EOCD_SIGNATURE) continue;

    const candidate = readEocdAt(buf, i);
    if (candidate && isPlausibleCentralDirectory(buf, candidate))
      return candidate;
  }
  throw new ZipInspectionError(
    "ZIP_INVALID_STRUCTURE",
    "no valid End of Central Directory record found"
  );
}

function readEocdAt(buf: Buffer, at: number): EocdInfo | null {
  if (at + EOCD_MIN_SIZE > buf.length) return null;

  let totalEntries = u16(buf, at + 10);
  let centralDirectorySize = u32(buf, at + 12);
  let centralDirectoryOffset = u32(buf, at + 16);

  const needsZip64 =
    totalEntries === ZIP64_SENTINEL_16 ||
    centralDirectorySize === ZIP64_SENTINEL_32 ||
    centralDirectoryOffset === ZIP64_SENTINEL_32;

  if (needsZip64) {
    // The ZIP64 locator sits immediately before the EOCD.
    const locatorAt = at - 20;
    if (locatorAt < 0 || u32(buf, locatorAt) !== EOCD64_LOCATOR_SIGNATURE)
      return null;
    const eocd64At = u64(buf, locatorAt + 8);
    if (
      eocd64At < 0 ||
      eocd64At + 56 > buf.length ||
      u32(buf, eocd64At) !== EOCD64_SIGNATURE
    ) {
      return null;
    }
    totalEntries = u64(buf, eocd64At + 32);
    centralDirectorySize = u64(buf, eocd64At + 40);
    centralDirectoryOffset = u64(buf, eocd64At + 48);
  }

  return { totalEntries, centralDirectorySize, centralDirectoryOffset };
}

function isPlausibleCentralDirectory(buf: Buffer, info: EocdInfo): boolean {
  const { centralDirectoryOffset: off, centralDirectorySize: size } = info;
  if (off < 0 || size < 0 || off + size > buf.length) return false;
  // An empty archive has no central directory to point at.
  if (info.totalEntries === 0) return size === 0;
  return size >= 46 && u32(buf, off) === CENTRAL_FILE_HEADER_SIGNATURE;
}

// ─── Central-directory entry ─────────────────────────────────────────────────

export interface ZipEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  compressionMethod: number;
  encrypted: boolean;
}

/**
 * Parse the central directory into entries. Bounded by `maxEntries`; a directory
 * that claims more, or whose records do not chain, is rejected rather than
 * silently truncated.
 */
function readCentralDirectory(
  buf: Buffer,
  info: EocdInfo,
  maxEntries: number
): ZipEntry[] {
  const entries: ZipEntry[] = [];
  const end = info.centralDirectoryOffset + info.centralDirectorySize;
  let p = info.centralDirectoryOffset;

  while (p + 46 <= end) {
    if (u32(buf, p) !== CENTRAL_FILE_HEADER_SIGNATURE) {
      throw new ZipInspectionError(
        "ZIP_INVALID_STRUCTURE",
        `central directory record ${entries.length} has a bad signature`
      );
    }
    if (entries.length >= maxEntries) {
      throw new ZipInspectionError(
        "ZIP_ENTRY_COUNT_EXCEEDED",
        `central directory holds more than ${maxEntries} entries`
      );
    }

    const flags = u16(buf, p + 8);
    const compressionMethod = u16(buf, p + 10);
    let compressedSize = u32(buf, p + 20);
    let uncompressedSize = u32(buf, p + 24);
    const nameLen = u16(buf, p + 28);
    const extraLen = u16(buf, p + 30);
    const commentLen = u16(buf, p + 32);

    const nameAt = p + 46;
    if (nameAt + nameLen + extraLen + commentLen > end) {
      throw new ZipInspectionError(
        "ZIP_INVALID_STRUCTURE",
        `central directory record ${entries.length} overruns the directory`
      );
    }
    const name = buf.subarray(nameAt, nameAt + nameLen).toString("utf8");

    // ZIP64 extra field (id 0x0001) supplies the real sizes when the 32-bit
    // fields hold the sentinel. Without this, 0xFFFFFFFF is read as a literal
    // 4 GiB — accidentally strict here, but attacker-controllable in general.
    if (
      uncompressedSize === ZIP64_SENTINEL_32 ||
      compressedSize === ZIP64_SENTINEL_32
    ) {
      const zip64 = findZip64Extra(buf, nameAt + nameLen, extraLen);
      if (zip64) {
        let o = 0;
        if (uncompressedSize === ZIP64_SENTINEL_32 && o + 8 <= zip64.length) {
          uncompressedSize = u64(zip64, o);
          o += 8;
        }
        if (compressedSize === ZIP64_SENTINEL_32 && o + 8 <= zip64.length) {
          compressedSize = u64(zip64, o);
        }
      }
    }

    entries.push({
      name,
      compressedSize,
      uncompressedSize,
      compressionMethod,
      encrypted:
        (flags & FLAG_ENCRYPTED) !== 0 ||
        (flags & FLAG_STRONG_ENCRYPTION) !== 0,
    });

    p = nameAt + nameLen + extraLen + commentLen;
  }

  return entries;
}

function findZip64Extra(
  buf: Buffer,
  at: number,
  length: number
): Buffer | null {
  let p = at;
  const end = at + length;
  while (p + 4 <= end) {
    const id = u16(buf, p);
    const size = u16(buf, p + 2);
    if (p + 4 + size > end) return null;
    if (id === 0x0001) return buf.subarray(p + 4, p + 4 + size);
    p += 4 + size;
  }
  return null;
}

// ─── Entry-name safety ───────────────────────────────────────────────────────

/**
 * Reject Zip-Slip names. Nothing in this service extracts an archive, but the
 * archive IS handed on to clients — which do — carrying our "passed security
 * validation" verdict with it.
 */
function assertSafeEntryName(name: string): void {
  if (name.includes("\0")) {
    throw new ZipInspectionError(
      "ZIP_PATH_TRAVERSAL",
      "entry name contains a NUL byte"
    );
  }
  const normalized = name.replace(/\\/g, "/");
  if (normalized.startsWith("/")) {
    throw new ZipInspectionError(
      "ZIP_PATH_TRAVERSAL",
      `entry name "${name}" is an absolute path`
    );
  }
  if (/^[a-zA-Z]:/.test(normalized)) {
    throw new ZipInspectionError(
      "ZIP_PATH_TRAVERSAL",
      `entry name "${name}" carries a drive letter`
    );
  }
  if (normalized.split("/").includes("..")) {
    throw new ZipInspectionError(
      "ZIP_PATH_TRAVERSAL",
      `entry name "${name}" escapes the archive root`
    );
  }
}

const extensionOfEntry = (name: string): string => {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot < 0 ? "" : base.slice(dot + 1).toLowerCase();
};

// ─── Public inspection function ───────────────────────────────────────────────

/**
 * Inspect a ZIP archive in memory.
 *
 * @param buf        Full bytes of the ZIP file as fetched from MinIO.
 * @param storedSize Actual on-disk size in bytes (MinIO HeadObject) — the
 *                   compressed reference for the ratio check.
 *
 * Throws {@link ZipInspectionError} on any violation; returns the parsed entry
 * list when the archive passes, so callers (e.g. the OOXML identifier) can reuse
 * it instead of re-parsing.
 */
export function inspectZip(buf: Buffer, storedSize: number): ZipEntry[] {
  if (buf.length < EOCD_MIN_SIZE) {
    throw new ZipInspectionError(
      "ZIP_INVALID_STRUCTURE",
      "buffer too small to be a valid ZIP"
    );
  }

  const eocd = findEocd(buf);

  if (eocd.totalEntries > ZIP_MAX_ENTRIES) {
    throw new ZipInspectionError(
      "ZIP_ENTRY_COUNT_EXCEEDED",
      `ZIP declares ${eocd.totalEntries} entries, exceeding the limit of ${ZIP_MAX_ENTRIES}`
    );
  }

  const entries = readCentralDirectory(buf, eocd, ZIP_MAX_ENTRIES);

  // Cross-check: the directory we actually walked must match what the EOCD
  // claims. A mismatch means a forged record somewhere.
  if (entries.length !== eocd.totalEntries) {
    throw new ZipInspectionError(
      "ZIP_INVALID_STRUCTURE",
      `EOCD declares ${eocd.totalEntries} entries but the central directory holds ${entries.length}`
    );
  }

  let totalUncompressed = 0;

  for (const entry of entries) {
    assertSafeEntryName(entry.name);

    if (entry.encrypted) {
      // An encrypted entry cannot be inspected here and cannot be scanned by
      // ClamAV either — accepting it would attach a "clean" verdict to bytes
      // nothing has read.
      throw new ZipInspectionError(
        "ZIP_ENCRYPTED_ENTRY",
        `entry "${entry.name}" is encrypted and cannot be scanned`
      );
    }

    const ext = extensionOfEntry(entry.name);
    if (NESTED_ARCHIVE_EXTENSIONS.has(ext)) {
      throw new ZipInspectionError(
        "ZIP_NESTED_ARCHIVE",
        `entry "${entry.name}" is a nested archive (.${ext})`
      );
    }
    if (EXECUTABLE_EXTENSIONS.has(ext)) {
      throw new ZipInspectionError(
        "ZIP_NESTED_ARCHIVE",
        `entry "${entry.name}" is an executable (.${ext})`
      );
    }

    totalUncompressed += entry.uncompressedSize;
  }

  if (totalUncompressed > ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES) {
    throw new ZipInspectionError(
      "ZIP_BOMB_DETECTED",
      `total uncompressed size ${totalUncompressed} exceeds ${ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES}`
    );
  }

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

  return entries;
}

// ─── OOXML identification ────────────────────────────────────────────────────

/**
 * Identify a DOCX/XLSX/PPTX from the central directory's entry NAMES.
 *
 * The previous implementation searched the raw bytes for `[Content_Types].xml`
 * and then substring-matched `wordprocessingml` in the following 8 KB. That
 * entry is normally DEFLATE-compressed, so the substring was usually absent, the
 * function returned `null`, and the caller treated `null` as "cannot tell →
 * accept" — a check that failed open in the common case.
 *
 * Entry names in the central directory are never compressed, so the part names
 * (`word/document.xml`, `xl/workbook.xml`, `ppt/presentation.xml`) are always
 * readable. Callers must treat `null` as a REJECTION for a declared OOXML type.
 */
export function detectOoxmlType(entries: ZipEntry[]): string | null {
  const names = entries.map((e) => e.name.replace(/\\/g, "/").toLowerCase());
  if (!names.includes("[content_types].xml")) return null;

  if (names.some((n) => n.startsWith("word/document"))) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  if (names.some((n) => n.startsWith("xl/workbook"))) {
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }
  if (names.some((n) => n.startsWith("ppt/presentation"))) {
    return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  }
  return null;
}

/**
 * VBA macro / OLE-object / external-reference parts inside an OOXML package.
 * Present as ordinary ZIP entries, so they are detectable from the directory
 * alone — no XML parsing, no decompression.
 */
const OOXML_ACTIVE_PARTS: Array<[RegExp, string]> = [
  [/(^|\/)vbaproject\.bin$/, "VBA macro project"],
  [/(^|\/)vbadata\.xml$/, "VBA data"],
  [/(^|\/)embeddings\/.+\.(bin|exe|dll|js|vbs)$/, "embedded OLE object"],
  [/(^|\/)activex\//, "ActiveX control"],
  [
    /(^|\/)word\/media\/.+\.(exe|dll|scr|js|vbs|bat|cmd)$/,
    "embedded executable",
  ],
];

/**
 * Returns a description of the first active-content part found, or null.
 * A `.docx` carrying a VBA project is a `.docm` in disguise; Office will happily
 * run it, so it is rejected rather than reported.
 */
export function detectOoxmlActiveContent(entries: ZipEntry[]): string | null {
  for (const entry of entries) {
    const name = entry.name.replace(/\\/g, "/").toLowerCase();
    for (const [pattern, label] of OOXML_ACTIVE_PARTS) {
      if (pattern.test(name)) return `${label} (${entry.name})`;
    }
  }
  return null;
}
