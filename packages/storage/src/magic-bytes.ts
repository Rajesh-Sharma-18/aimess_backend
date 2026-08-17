/**
 * Magic-byte (file signature) validation.
 *
 * Clients declare a MIME type when requesting a presigned upload URL. After the
 * PUT lands in MinIO the caller streams the first N bytes back through
 * `matchMagicBytes` to verify the actual file format matches the declaration.
 *
 * Why this matters: a client can rename `malware.exe` to `report.docx`, declare
 * MIME `application/vnd.openxmlformats-officedocument.wordprocessingml.document`,
 * and upload it. Extension + MIME header checks alone cannot catch this — only
 * inspecting the raw bytes can.
 *
 * OOXML note: DOCX, XLSX and PPTX are all ZIP archives (PK\x03\x04 signature).
 * `matchMagicBytes` returns `"application/zip"` for any PK file. The caller
 * must additionally inspect the ZIP's internal directory (via `inspectOoxml`) to
 * confirm the correct Office content-type is present. This two-step approach is
 * intentional: the magic-byte layer catches non-archives masquerading as OOXML,
 * while the OOXML inspector catches wrong Office types and plain ZIPs declared as
 * Office docs.
 */

/** Minimum number of bytes that must be fetched from storage for detection. */
export const MAGIC_BYTES_SAMPLE_SIZE = 512;

/**
 * Placeholder MIME for the shared ISO-base-media `ftyp` signature. Never
 * returned by {@link matchMagicBytes} — it is resolved to a concrete type from
 * the file's brand list before the result leaves the function.
 */
const ISOBMFF_SENTINEL = "application/x-isobmff";

/** HEIF-family brands (HEIC still images and their sequences). */
const HEIF_BRANDS = new Set([
  "heic",
  "heix",
  "heim",
  "heis",
  "hevc",
  "hevx",
  "mif1",
  "msf1",
]);

/** AVIF brands — AV1 stills, same container family. */
const AVIF_BRANDS = new Set(["avif", "avis"]);

/**
 * Resolve an ISO-base-media file to a concrete MIME from its `ftyp` brands.
 * The major brand sits at offset 8 and the compatible-brand list follows at 16,
 * running to the end of the (usually tiny) ftyp box.
 */
function isobmffMime(buf: Buffer): string {
  const brands: string[] = [];
  const read = (o: number): string => buf.subarray(o, o + 4).toString("latin1");
  if (buf.length >= 12) brands.push(read(8));
  const boxSize = buf.length >= 4 ? buf.readUInt32BE(0) : 0;
  const end = Math.min(boxSize, buf.length);
  for (let o = 16; o + 4 <= end; o += 4) brands.push(read(o));

  if (brands.some((b) => AVIF_BRANDS.has(b))) return "image/avif";
  if (brands.some((b) => HEIF_BRANDS.has(b))) return "image/heic";
  if (brands.some((b) => b === "qt  ")) return "video/quicktime";
  return "video/mp4";
}

/**
 * Top-level atom types that begin a CLASSIC QuickTime movie.
 *
 * `.mov` predates the ISO base media spec and is not required to carry an `ftyp`
 * box: QuickTime Player exports, several camera/screen recorders and older
 * editing tools emit a file whose first atom is `moov`/`mdat`/`wide`/`free`.
 * Those files are valid `video/quicktime` but matched no signature at all, so
 * `assertMagicBytesMatch` rejected them as "no recognisable file signature" and
 * `/media/confirm` reported REJECTED for a perfectly good upload.
 */
const QUICKTIME_TOP_LEVEL_ATOMS = new Set([
  "moov",
  "mdat",
  "wide",
  "free",
  "skip",
  "pnot",
]);

/** True when `buf` starts with a classic (ftyp-less) QuickTime atom. */
export function isClassicQuickTime(buf: Buffer): boolean {
  if (buf.length < 8) return false;
  const size = buf.readUInt32BE(0);
  // size 0 = "runs to end of file", 1 = 64-bit size follows; anything else must
  // be a real atom length, which rules out a random 8-byte prefix.
  if (size !== 0 && size !== 1 && size < 8) return false;
  return QUICKTIME_TOP_LEVEL_ATOMS.has(buf.subarray(4, 8).toString("latin1"));
}

/** A single file-signature rule. */
interface Signature {
  /** Raw bytes to match. `null` entries are wildcard (skip that byte position). */
  bytes: (number | null)[];
  /** Byte offset at which the pattern starts in the file. Default 0. */
  offset?: number;
  /** MIME type this signature identifies. */
  mime: string;
}

/**
 * Known signatures. Ordered from most-specific to least-specific so an early
 * match does not shadow a longer pattern.
 */
const SIGNATURES: Signature[] = [
  // PDF
  { bytes: [0x25, 0x50, 0x44, 0x46], mime: "application/pdf" },

  // ZIP (PK header) — covers DOCX / XLSX / PPTX / plain ZIP
  { bytes: [0x50, 0x4b, 0x03, 0x04], mime: "application/zip" },
  // ZIP: empty archive variant
  { bytes: [0x50, 0x4b, 0x05, 0x06], mime: "application/zip" },
  // ZIP: spanned archive variant
  { bytes: [0x50, 0x4b, 0x07, 0x08], mime: "application/zip" },

  // Legacy Office compound document (DOC / XLS / PPT) — Compound File Binary
  {
    bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1],
    mime: "application/msword",
  },

  // JPEG
  { bytes: [0xff, 0xd8, 0xff], mime: "image/jpeg" },

  // PNG
  {
    bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    mime: "image/png",
  },

  // GIF87a / GIF89a
  { bytes: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61], mime: "image/gif" },
  { bytes: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61], mime: "image/gif" },

  // WebP (RIFF....WEBP)
  {
    bytes: [
      0x52,
      0x49,
      0x46,
      0x46,
      null,
      null,
      null,
      null,
      0x57,
      0x45,
      0x42,
      0x50,
    ],
    mime: "image/webp",
  },

  // ISO base media (ftyp box at offset 4). The concrete type is decided by the
  // brand, NOT by the box name — HEIC, HEIF, AVIF, MOV and MP4 all start with
  // the same 8 bytes, so a bare `????ftyp` rule let a HEIC through as
  // `video/mp4` (and vice versa). `matchMagicBytes` special-cases this below.
  {
    bytes: [null, null, null, null, 0x66, 0x74, 0x79, 0x70],
    offset: 0,
    mime: ISOBMFF_SENTINEL,
  },

  // MKV / WebM (EBML header)
  { bytes: [0x1a, 0x45, 0xdf, 0xa3], mime: "video/x-matroska" },

  // OGG (covers audio/ogg and video/ogg)
  { bytes: [0x4f, 0x67, 0x67, 0x53], mime: "audio/ogg" },

  // MP3 (ID3 tag or sync bytes)
  { bytes: [0x49, 0x44, 0x33], mime: "audio/mpeg" },
  { bytes: [0xff, 0xfb], mime: "audio/mpeg" },

  // FLAC
  { bytes: [0x66, 0x4c, 0x61, 0x43], mime: "audio/flac" },

  // RIFF WAV
  {
    bytes: [
      0x52,
      0x49,
      0x46,
      0x46,
      null,
      null,
      null,
      null,
      0x57,
      0x41,
      0x56,
      0x45,
    ],
    mime: "audio/wav",
  },
];

/** Checks whether `buf` starts with the bytes of `sig` at `sig.offset`. */
function matchesSignature(buf: Buffer, sig: Signature): boolean {
  const start = sig.offset ?? 0;
  if (buf.length < start + sig.bytes.length) return false;
  for (let i = 0; i < sig.bytes.length; i++) {
    const expected = sig.bytes[i];
    if (expected !== null && buf[start + i] !== expected) return false;
  }
  return true;
}

/**
 * Inspect the first `MAGIC_BYTES_SAMPLE_SIZE` bytes of a file and return the
 * detected MIME type, or `null` when no signature matches.
 *
 * For OOXML types (DOCX/XLSX/PPTX) this returns `"application/zip"` — the
 * caller must perform a second-level OOXML inspection if needed.
 */
export function matchMagicBytes(buf: Buffer): string | null {
  for (const sig of SIGNATURES) {
    if (!matchesSignature(buf, sig)) continue;
    return sig.mime === ISOBMFF_SENTINEL ? isobmffMime(buf) : sig.mime;
  }
  // No ftyp box — the only format that legitimately looks like this is a classic
  // QuickTime movie. Structural inspection still has to confirm the box tree.
  if (isClassicQuickTime(buf)) return "video/quicktime";
  return null;
}

/**
 * Set of MIME types whose magic bytes all resolve to `"application/zip"` (i.e.
 * OOXML files — they ARE ZIP archives internally). When the declared MIME is in
 * this set and `matchMagicBytes` returns `"application/zip"`, the bytes are
 * valid; additional OOXML-level inspection decides whether the content-type
 * is correct.
 */
export const OOXML_MIME_TYPES = new Set<string>([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

/**
 * Map of declared MIME → acceptable detected MIME(s) from `matchMagicBytes`.
 *
 * A declared MIME is valid when `matchMagicBytes(buf)` returns any value in its
 * set. Multiple acceptable values cover format families (e.g. DOC/XLS/PPT share
 * the same Compound Document signature; OOXML shares the ZIP signature).
 */
export const MAGIC_BYTE_ACCEPT_MAP: Record<string, Set<string>> = {
  // Images
  "image/jpeg": new Set(["image/jpeg"]),
  "image/png": new Set(["image/png"]),
  "image/webp": new Set(["image/webp"]),
  "image/gif": new Set(["image/gif"]),
  // HEIC/HEIF — ISO base media stills. The brand list distinguishes these from
  // an MP4 (see `isobmffMime`), so the two can no longer impersonate each other.
  "image/heic": new Set(["image/heic"]),
  "image/heif": new Set(["image/heic"]),
  "image/avif": new Set(["image/avif"]),
  // Video
  "video/mp4": new Set(["video/mp4"]),
  "video/quicktime": new Set(["video/mp4", "video/quicktime"]),
  "video/x-matroska": new Set(["video/x-matroska"]),
  "video/webm": new Set(["video/x-matroska"]),
  // AVI: `RIFF....AVI ` IS a reliable signature — the previous empty set meant
  // an AVI declaration skipped content validation entirely.
  "video/x-msvideo": new Set(["video/x-msvideo"]),
  "video/x-m4v": new Set(["video/mp4"]),
  // Audio
  "audio/mpeg": new Set(["audio/mpeg"]),
  "audio/ogg": new Set(["audio/ogg"]),
  "audio/wav": new Set(["audio/wav"]),
  "audio/mp4": new Set(["video/mp4"]),
  "audio/x-m4a": new Set(["video/mp4"]),
  // Raw AAC genuinely has no file-level signature — validation is deferred to
  // the ADTS frame-chaining check in `deep-inspect.ts#inspectAac`, which is a
  // signature in practice. Empty here means "deferred", never "skipped".
  "audio/aac": new Set([]),
  "audio/flac": new Set(["audio/flac"]),
  // Documents
  "application/pdf": new Set(["application/pdf"]),
  "application/msword": new Set(["application/msword"]),
  "application/vnd.ms-excel": new Set(["application/msword"]), // same CFB signature
  "application/vnd.ms-powerpoint": new Set(["application/msword"]), // same CFB signature
  // OOXML — all are ZIP internally
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    new Set(["application/zip"]),
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": new Set([
    "application/zip",
  ]),
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    new Set(["application/zip"]),
  // Text/data have no positive signature by definition. Validation is deferred
  // to `deep-inspect.ts#inspectTextual`, which applies the NEGATIVE signature
  // (no NUL bytes, valid UTF-8, does not begin with another format's magic
  // number, no active-content markers). Empty here means "deferred to the
  // structural inspector", never "skipped" — declaring text/plain used to be
  // the widest bypass in the pipeline.
  "text/plain": new Set([]),
  "text/csv": new Set([]),
  "application/json": new Set([]),
  "application/xml": new Set([]),
  "text/xml": new Set([]),
  // Archives
  "application/zip": new Set(["application/zip"]),
  "application/x-zip-compressed": new Set(["application/zip"]),
};

/**
 * Validate that `buf` (first bytes of an uploaded file) is consistent with
 * `declaredMime`. Throws {@link MagicByteValidationError} when the bytes
 * contradict the declaration.
 *
 * Two deliberate behaviours:
 *
 *  - A MIME **absent** from {@link MAGIC_BYTE_ACCEPT_MAP} FAILS CLOSED. It used
 *    to return silently, which meant any MIME outside the map (`application/
 *    octet-stream`, `application/x-msdownload`, a typo) disabled the check. The
 *    map is the allow-list; not being on it is a rejection.
 *  - An **empty** accept-set means "this format has no file-level signature and
 *    is validated structurally instead" (text/*, raw AAC). Those types must be
 *    passed to `inspectMedia` from `deep-inspect.ts`; the caller is responsible
 *    for running it, and the media-service confirm pipeline always does.
 */
export function assertMagicBytesMatch(buf: Buffer, declaredMime: string): void {
  const acceptSet = MAGIC_BYTE_ACCEPT_MAP[declaredMime];
  if (!acceptSet) {
    throw new MagicByteValidationError(
      `Declared MIME ${declaredMime} has no signature policy`
    );
  }
  // Deferred to the structural inspector (see docblock).
  if (acceptSet.size === 0) return;

  const detected = matchMagicBytes(buf);
  if (detected === null) {
    // Could not detect any known signature — conservatively block
    throw new MagicByteValidationError(
      `No recognisable file signature found for declared MIME ${declaredMime}`
    );
  }
  if (!acceptSet.has(detected)) {
    throw new MagicByteValidationError(
      `File signature mismatch: declared ${declaredMime} but detected ${detected}`
    );
  }
}

export class MagicByteValidationError extends Error {
  readonly code = "MAGIC_BYTE_MISMATCH" as const;
  constructor(detail: string) {
    super(detail);
    this.name = "MagicByteValidationError";
  }
}
