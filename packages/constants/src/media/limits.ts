/**
 * Resource limits for uploaded media — the SINGLE source of truth for every
 * ceiling that is NOT a byte count.
 *
 * Byte ceilings deliberately live in env (see media-service `config/env.ts` and
 * chat-service `constants/media-limits.ts`) because ops tunes them per
 * deployment. Everything here is a *structural* limit that exists to stop a
 * small file from costing a large amount of CPU/RAM during decoding — a
 * decompression bomb. Those are properties of the format, not of the
 * deployment, so they are pinned in code and shared by every validator.
 *
 * All of these are enforced by `@aimess/storage`'s `inspectMedia`, which reads
 * the values out of a caller-supplied {@link MediaStructuralLimits} so tests can
 * shrink them without touching the production numbers.
 */

export interface MediaStructuralLimits {
  /** Max width or height, in pixels, for any single image. */
  maxImageDimension: number;
  /** Max total pixel count (width × height) — the decompression-bomb guard. */
  maxImagePixels: number;
  /** Max animation frames in a GIF / animated WebP. */
  maxAnimationFrames: number;
  /** Max width or height of a video track. */
  maxVideoDimension: number;
  /** Max video duration in milliseconds. */
  maxVideoDurationMs: number;
  /** Max audio duration in milliseconds. */
  maxAudioDurationMs: number;
  /**
   * Max bytes of CONTENT allowed after a format's own end-of-file marker.
   *
   * A JPEG's EOI, a PNG's IEND and a GIF's trailer mark the true end of the
   * image; anything past it is payload the image parser never sees, which is
   * exactly how a JPEG+ZIP / JPEG+HTML / JPEG+executable polyglot is built.
   *
   * Zero, and it means zero: the inspector's `measureTrailing` already discounts
   * pure padding (NUL/whitespace, which is what real encoders emit), so this
   * budget applies only to actual appended content. A flat byte allowance was
   * the wrong shape — a 6-byte appended MZ stub and 6 bytes of zero padding are
   * the same length and nothing alike.
   */
  maxTrailingBytes: number;
  /** Max nesting depth walked in a box/chunk-structured container. */
  maxContainerDepth: number;
  /** Max number of boxes/chunks walked before the parser gives up. */
  maxContainerNodes: number;
}

/**
 * Production limits.
 *
 * `maxImagePixels` of 100 MP admits every real camera/phone image (a 108 MP
 * phone sensor shot is ~108 MP but is never uploaded un-downscaled through a
 * chat client) while rejecting the classic decompression bomb: a ~2 KB PNG that
 * declares 64000×64000 and expands to ~16 GB of RGBA in the decoder.
 *
 * `maxVideoDurationMs` / `maxAudioDurationMs` mirror the caps chat-service
 * already applies to the client-declared `durationMs`
 * (apps/chat-service/src/constants/media-limits.ts) — the difference is that
 * these are checked against the duration read out of the actual container, so
 * omitting the field no longer skips the check.
 */
export const MEDIA_STRUCTURAL_LIMITS: MediaStructuralLimits = {
  maxImageDimension: 20_000,
  maxImagePixels: 100_000_000,
  maxAnimationFrames: 1_500,
  maxVideoDimension: 8_192,
  maxVideoDurationMs: 3 * 60 * 60 * 1000,
  maxAudioDurationMs: 3 * 60 * 60 * 1000,
  maxTrailingBytes: 0,
  maxContainerDepth: 16,
  maxContainerNodes: 4_096,
};

/**
 * How many bytes of an object the deep inspector needs.
 *
 * Images are read whole — they are capped at 25 MB and trailing-data detection
 * is only possible with the tail in hand. Audio/video containers are capped at
 * 100 MB, far too large to hold in memory per request, so they are probed from
 * a head window plus a tail window: `ftyp`/EBML always sit at the front, and a
 * non-faststart MP4 keeps its `moov` (which carries duration and dimensions) at
 * the very end.
 */
export const MEDIA_PROBE_BYTES = {
  /** Head window for a container probe. */
  containerHead: 2 * 1024 * 1024,
  /** Tail window for a container probe (finds a trailing `moov`). */
  containerTail: 2 * 1024 * 1024,
  /** Above this size an image is rejected before it is loaded into memory. */
  maxInMemoryImage: 64 * 1024 * 1024,
} as const;

/**
 * Machine-readable rejection reasons produced by the structural inspector.
 * These are INTERNAL — they are logged and persisted to `MediaFile.scanDetail`,
 * never returned to a client, which only ever sees the coarse
 * `MEDIA_*` error codes. Keeping the two vocabularies separate is what stops
 * detector internals (thresholds, engine names, offsets) from leaking.
 */
export const MEDIA_REJECT_CODES = [
  "SIGNATURE_MISMATCH",
  "MALFORMED_CONTAINER",
  "TRUNCATED",
  "DIMENSIONS_EXCEEDED",
  "PIXELS_EXCEEDED",
  "FRAMES_EXCEEDED",
  "DURATION_EXCEEDED",
  "TRAILING_DATA",
  "SUSPICIOUS_CONTENT",
  "SIZE_EXCEEDED",
  "EMPTY",
  "ZIP_BOMB_DETECTED",
  "ZIP_NESTED_ARCHIVE",
  "ZIP_ENTRY_COUNT_EXCEEDED",
  "ZIP_INVALID_STRUCTURE",
  "ZIP_PATH_TRAVERSAL",
  "ZIP_ENCRYPTED_ENTRY",
  "OOXML_TYPE_MISMATCH",
] as const;
export type MediaRejectCode = (typeof MEDIA_REJECT_CODES)[number];

/**
 * The CLIENT-SAFE half of the rejection vocabulary.
 *
 * A rejected upload used to reach the uploader as nothing but `REJECTED`, which
 * every client can only render as "this file could not be verified" — true, and
 * useless: the person cannot tell a renamed screenshot from a half-finished
 * download from a file that is simply too long. These five buckets say what the
 * user has to DO about it while still telling an attacker nothing they did not
 * already know by submitting the file: which detector fired, at what threshold,
 * at which offset, and under which engine all stay in {@link MediaRejectCode},
 * the audit log, and `MediaFile.scanDetail`.
 *
 *   FORMAT_MISMATCH — the bytes are not the type the file claims to be.
 *   FILE_DAMAGED    — right type, but truncated or structurally broken.
 *   TOO_LARGE       — over a limit: bytes, dimensions, pixels, frames, duration.
 *   UNSAFE_CONTENT  — refused on safety grounds (archive tricks, hidden payload).
 *   FILE_EMPTY      — no bytes at all.
 */
export const MEDIA_PUBLIC_REJECT_REASONS = [
  "FORMAT_MISMATCH",
  "FILE_DAMAGED",
  "TOO_LARGE",
  "UNSAFE_CONTENT",
  "FILE_EMPTY",
] as const;
export type MediaPublicRejectReason =
  (typeof MEDIA_PUBLIC_REJECT_REASONS)[number];

/**
 * Internal reject code → the bucket the uploader is told about. Exhaustive by
 * type: a new {@link MediaRejectCode} does not compile until it is classified,
 * so nothing can silently fall back to the vague verdict this table exists to
 * replace.
 */
export const PUBLIC_REJECT_REASON: Record<
  MediaRejectCode,
  MediaPublicRejectReason
> = {
  SIGNATURE_MISMATCH: "FORMAT_MISMATCH",
  OOXML_TYPE_MISMATCH: "FORMAT_MISMATCH",
  MALFORMED_CONTAINER: "FILE_DAMAGED",
  TRUNCATED: "FILE_DAMAGED",
  ZIP_INVALID_STRUCTURE: "FILE_DAMAGED",
  SIZE_EXCEEDED: "TOO_LARGE",
  DIMENSIONS_EXCEEDED: "TOO_LARGE",
  PIXELS_EXCEEDED: "TOO_LARGE",
  FRAMES_EXCEEDED: "TOO_LARGE",
  DURATION_EXCEEDED: "TOO_LARGE",
  ZIP_ENTRY_COUNT_EXCEEDED: "TOO_LARGE",
  // Bytes after the format's own end marker are how a polyglot hides a second
  // file inside a valid one — a safety verdict, not a damaged-file verdict.
  TRAILING_DATA: "UNSAFE_CONTENT",
  SUSPICIOUS_CONTENT: "UNSAFE_CONTENT",
  ZIP_BOMB_DETECTED: "UNSAFE_CONTENT",
  ZIP_NESTED_ARCHIVE: "UNSAFE_CONTENT",
  ZIP_PATH_TRAVERSAL: "UNSAFE_CONTENT",
  ZIP_ENCRYPTED_ENTRY: "UNSAFE_CONTENT",
  EMPTY: "FILE_EMPTY",
};
