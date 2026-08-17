/**
 * Deep structural inspection of uploaded media.
 *
 * `magic-bytes.ts` answers "do the first few bytes look like the declared
 * type?". That is necessary and nowhere near sufficient: a 3-byte `FF D8 FF`
 * prefix in front of a ZIP archive satisfies it, a 2 KB PNG that declares
 * 64000x64000 satisfies it, and a file that is a valid JPEG followed by 40 MB of
 * appended HTML satisfies it. This module answers the harder question — "is the
 * WHOLE file actually a well-formed instance of that format, and is decoding it
 * affordable?" — by walking each format's own structure.
 *
 * Design constraints that shaped it:
 *
 *   • **No native dependencies.** `sharp`/`libvips`/`ffmpeg` would give richer
 *     answers but each is a platform-specific binary that has to be built into
 *     every service image, and every one of them is itself a memory-unsafe
 *     parser reached by untrusted bytes. Everything here is pure TypeScript over
 *     a Buffer: no subprocess, no filesystem, no allocation proportional to the
 *     *declared* dimensions (which is precisely how a decompression bomb wins).
 *   • **Header/box depth, not full decode.** Every limit that matters for
 *     resource exhaustion — pixel count, frame count, duration, track size — is
 *     declared in the container metadata and can be read without decompressing a
 *     single pixel. We reject on the declaration, so the bomb never reaches a
 *     decoder at all.
 *   • **Bounded work.** Every walker is capped by `maxContainerNodes` and
 *     `maxContainerDepth`, and every offset advance is checked to be strictly
 *     forward, so a malformed/hostile file cannot spin the parser.
 *
 * What this does NOT do, deliberately: it never re-encodes. Stripping EXIF or
 * normalising an image requires a real codec (see above). Metadata that is found
 * is REPORTED (`metadata[]`) so the caller can decide; `stripImageMetadata`
 * below removes the common metadata containers by byte surgery for the two
 * formats where that is safe to do without a decoder.
 */

import {
  MEDIA_STRUCTURAL_LIMITS,
  type MediaRejectCode,
  type MediaStructuralLimits,
} from "@aimess/constants";

import { isClassicQuickTime } from "./magic-bytes.js";

// ─── Public surface ──────────────────────────────────────────────────────────

export interface DeepInspectInput {
  /** Head window of the object — or the COMPLETE object when `complete`. */
  head: Buffer;
  /** Optional tail window, for containers whose index sits at the end. */
  tail?: Buffer;
  /** True object size in bytes (from HeadObject), NOT `head.length`. */
  totalSize: number;
  /** The MIME the server trusts (registry / signed PUT metadata). */
  declaredMime: string;
  /** True when `head` is the entire object; enables trailing-data detection. */
  complete: boolean;
  /** Overridable for tests. Defaults to the production table. */
  limits?: MediaStructuralLimits;
}

export interface DeepInspectResult {
  ok: boolean;
  /** Machine-readable reason. INTERNAL — never returned to a client verbatim. */
  code?: MediaRejectCode;
  /** Human detail for the audit log. INTERNAL. */
  detail?: string;
  /** Format identified from the actual structure, not the declaration. */
  detectedMime: string | null;
  width?: number;
  height?: number;
  frames?: number;
  durationMs?: number;
  /** Metadata containers found: "exif" | "gps" | "xmp" | "iptc" | "icc" | … */
  metadata: string[];
  /** Bytes present after the format's own end marker. Only set when `complete`. */
  trailingBytes?: number;
}

class RejectError extends Error {
  constructor(
    readonly code: MediaRejectCode,
    detail: string
  ) {
    super(detail);
  }
}

const reject = (code: MediaRejectCode, detail: string): never => {
  throw new RejectError(code, detail);
};

/** Formats whose inspection needs the whole file, so the caller must fetch it. */
export function needsCompleteBytes(mime: string): boolean {
  return mime.startsWith("image/") || mime === "application/pdf";
}

/**
 * Inspect `input` and decide whether it is a safe, well-formed instance of
 * `declaredMime`. Never throws — every failure is returned as `{ ok: false }`
 * with a machine-readable `code`, so a parser bug on hostile input degrades to a
 * rejection rather than a 500.
 */
export function inspectMedia(input: DeepInspectInput): DeepInspectResult {
  const limits = input.limits ?? MEDIA_STRUCTURAL_LIMITS;
  const base: DeepInspectResult = {
    ok: true,
    detectedMime: null,
    metadata: [],
  };

  if (input.totalSize <= 0 || input.head.length === 0) {
    return { ...base, ok: false, code: "EMPTY", detail: "object has no bytes" };
  }

  try {
    const out = dispatch(input, limits, base);
    assertDetectedMatchesDeclared(input.declaredMime, out.detectedMime);
    enforceLimits(out, input.declaredMime, limits);
    return out;
  } catch (err) {
    if (err instanceof RejectError) {
      return { ...base, ok: false, code: err.code, detail: err.message };
    }
    // A parser that walked off the end of a hostile buffer is itself a signal.
    return {
      ...base,
      ok: false,
      code: "MALFORMED_CONTAINER",
      detail: `inspector fault: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function dispatch(
  input: DeepInspectInput,
  limits: MediaStructuralLimits,
  base: DeepInspectResult
): DeepInspectResult {
  const mime = input.declaredMime.toLowerCase();
  const { head } = input;

  switch (mime) {
    case "image/jpeg":
      return inspectJpeg(input, base);
    case "image/png":
      return inspectPng(input, base, limits);
    case "image/gif":
      return inspectGif(input, base, limits);
    case "image/webp":
      return inspectWebp(input, base, limits);
    case "image/heic":
    case "image/heif":
    case "image/avif":
      return inspectIsobmff(input, base, limits);
    case "video/mp4":
    case "video/quicktime":
    case "video/x-m4v":
    case "audio/mp4":
    case "audio/x-m4a":
      return inspectIsobmff(input, base, limits);
    case "video/x-matroska":
    case "video/webm":
      return inspectMatroska(input, base, limits);
    case "audio/ogg":
      return inspectOgg(input, base);
    case "audio/wav":
      return inspectWav(input, base);
    case "audio/flac":
      return inspectFlac(input, base);
    case "audio/mpeg":
      return inspectMp3(input, base);
    case "audio/aac":
      return inspectAac(input, base);
    case "video/x-msvideo":
      return inspectAvi(input, base, limits);
    case "application/pdf":
      return inspectPdf(input, base);
    case "text/plain":
    case "text/csv":
    case "application/json":
    case "application/xml":
    case "text/xml":
      return inspectTextual(input, base, mime);
    default:
      // ZIP / OOXML / legacy Office are handled by the dedicated ZIP inspector;
      // anything else unknown gets the generic binary-sanity pass rather than a
      // silent skip — an unrecognised declared MIME must never mean "no checks".
      if (isZipFamily(mime) || isCompoundOffice(mime)) {
        return { ...base, detectedMime: mime };
      }
      return {
        ...base,
        detectedMime: sniff(head),
      };
  }
}

const isZipFamily = (m: string): boolean =>
  m === "application/zip" ||
  m === "application/x-zip-compressed" ||
  m.startsWith("application/vnd.openxmlformats-officedocument.");

const isCompoundOffice = (m: string): boolean =>
  m === "application/msword" ||
  m === "application/vnd.ms-excel" ||
  m === "application/vnd.ms-powerpoint";

// ─── Declared-vs-detected reconciliation ─────────────────────────────────────

/**
 * Format families where one container legitimately backs several MIME types, so
 * the inspector naming the family is not a contradiction of the declaration.
 *
 * Everything NOT listed here must match exactly. That is what stops a HEIC being
 * accepted as an MP4 (and vice versa): they share the `ftyp` box and were
 * indistinguishable to the old magic-byte rule, but their BRANDS differ, and
 * `isobmffMimeForBrands` resolves the brand before this comparison runs.
 */
const DETECTED_MIME_ALIASES: Record<string, ReadonlySet<string>> = {
  "video/quicktime": new Set(["video/mp4", "video/quicktime"]),
  "video/x-m4v": new Set(["video/mp4"]),
  "audio/mp4": new Set(["video/mp4", "audio/mp4"]),
  "audio/x-m4a": new Set(["video/mp4", "audio/mp4"]),
  "video/webm": new Set(["video/webm", "video/x-matroska"]),
  "video/x-matroska": new Set(["video/webm", "video/x-matroska"]),
  "image/heif": new Set(["image/heic", "image/heif"]),
  "image/heic": new Set(["image/heic", "image/heif"]),
  "text/xml": new Set(["application/xml", "text/xml"]),
  "application/xml": new Set(["application/xml", "text/xml"]),
};

function assertDetectedMatchesDeclared(
  declared: string,
  detected: string | null
): void {
  if (!detected || detected === declared) return;
  if (DETECTED_MIME_ALIASES[declared]?.has(detected)) return;
  reject(
    "SIGNATURE_MISMATCH",
    `declared ${declared} but the structure is ${detected}`
  );
}

// ─── Trailing-data measurement ───────────────────────────────────────────────

/**
 * Bytes present after a format's own end-of-file marker, ignoring pure padding.
 *
 * A flat byte allowance is the wrong shape for this: a 6-byte appended
 * executable stub and 6 bytes of encoder zero-padding are the same length and
 * nothing alike. Real padding is NUL bytes or whitespace; a payload is not. So
 * trailing bytes that are entirely padding count as zero, and ANY non-padding
 * byte past the end marker counts in full — which makes the limit effectively
 * "no appended content", with the tolerance reserved for what it was meant for.
 */
function measureTrailing(
  buf: Buffer,
  endOffset: number,
  totalSize: number
): number {
  const count = totalSize - endOffset;
  if (count <= 0) return 0;
  // Only what we actually hold can be examined; if the tail is beyond the
  // buffer we must assume it is content.
  const available = buf.subarray(endOffset, Math.min(buf.length, totalSize));
  if (available.length < count) return count;
  for (const byte of available) {
    const isPadding =
      byte === 0x00 ||
      byte === 0x0a ||
      byte === 0x0d ||
      byte === 0x20 ||
      byte === 0x09;
    if (!isPadding) return count;
  }
  return 0;
}

// ─── Shared limit enforcement ────────────────────────────────────────────────

function enforceLimits(
  r: DeepInspectResult,
  declaredMime: string,
  limits: MediaStructuralLimits
): void {
  const isImage = declaredMime.startsWith("image/");
  const isVideo = declaredMime.startsWith("video/");
  const isAudio = declaredMime.startsWith("audio/");

  const maxDim = isImage ? limits.maxImageDimension : limits.maxVideoDimension;
  if (r.width != null && r.height != null) {
    if (r.width <= 0 || r.height <= 0) {
      reject(
        "MALFORMED_CONTAINER",
        `non-positive dimensions ${r.width}x${r.height}`
      );
    }
    if (r.width > maxDim || r.height > maxDim) {
      reject(
        "DIMENSIONS_EXCEEDED",
        `${r.width}x${r.height} exceeds the ${maxDim}px per-side limit`
      );
    }
    if (isImage && r.width * r.height > limits.maxImagePixels) {
      reject(
        "PIXELS_EXCEEDED",
        `${r.width * r.height} pixels exceeds the ${limits.maxImagePixels} limit`
      );
    }
  }

  if (r.frames != null && r.frames > limits.maxAnimationFrames) {
    reject(
      "FRAMES_EXCEEDED",
      `${r.frames} frames exceeds the ${limits.maxAnimationFrames} limit`
    );
  }

  if (r.durationMs != null) {
    const maxMs = isVideo
      ? limits.maxVideoDurationMs
      : limits.maxAudioDurationMs;
    if ((isVideo || isAudio) && r.durationMs > maxMs) {
      reject(
        "DURATION_EXCEEDED",
        `${Math.round(r.durationMs / 1000)}s exceeds the ${Math.round(maxMs / 1000)}s limit`
      );
    }
  }

  if (r.trailingBytes != null && r.trailingBytes > limits.maxTrailingBytes) {
    // The polyglot guard. A valid image followed by an archive/script/executable
    // is the standard way to smuggle a payload past an image-only allow-list.
    reject(
      "TRAILING_DATA",
      `${r.trailingBytes} bytes present after the end-of-file marker`
    );
  }
}

// ─── Buffer helpers ──────────────────────────────────────────────────────────

function need(buf: Buffer, offset: number, length: number, what: string): void {
  if (offset < 0 || offset + length > buf.length) {
    reject(
      "TRUNCATED",
      `${what}: need ${length}B at ${offset}, have ${buf.length}`
    );
  }
}

const ascii = (buf: Buffer, offset: number, length: number): string =>
  buf.subarray(offset, offset + length).toString("latin1");

/** Cheap format sniff used only for reporting a mismatch. */
export function sniff(buf: Buffer): string | null {
  const b = buf;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
    return "image/jpeg";
  if (b.length >= 8 && ascii(b, 1, 3) === "PNG") return "image/png";
  if (b.length >= 6 && ascii(b, 0, 3) === "GIF") return "image/gif";
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF") {
    const kind = ascii(b, 8, 4);
    if (kind === "WEBP") return "image/webp";
    if (kind === "WAVE") return "audio/wav";
    if (kind === "AVI ") return "video/x-msvideo";
  }
  if (b.length >= 12 && ascii(b, 4, 4) === "ftyp")
    return isobmffMimeForBrands(b);
  // Classic QuickTime carries no ftyp box at all.
  if (isClassicQuickTime(b)) return "video/quicktime";
  if (
    b.length >= 4 &&
    b[0] === 0x1a &&
    b[1] === 0x45 &&
    b[2] === 0xdf &&
    b[3] === 0xa3
  )
    return "video/x-matroska";
  if (b.length >= 4 && ascii(b, 0, 4) === "OggS") return "audio/ogg";
  if (b.length >= 4 && ascii(b, 0, 4) === "fLaC") return "audio/flac";
  if (b.length >= 3 && ascii(b, 0, 3) === "ID3") return "audio/mpeg";
  if (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0)
    return "audio/mpeg";
  if (b.length >= 4 && ascii(b, 0, 4) === "%PDF") return "application/pdf";
  if (b.length >= 2 && b[0] === 0x50 && b[1] === 0x4b) return "application/zip";
  if (b.length >= 2 && b[0] === 0x4d && b[1] === 0x5a)
    return "application/x-msdownload";
  if (b.length >= 4 && b[0] === 0x7f && ascii(b, 1, 3) === "ELF")
    return "application/x-elf";
  if (
    b.length >= 8 &&
    b[0] === 0xd0 &&
    b[1] === 0xcf &&
    b[2] === 0x11 &&
    b[3] === 0xe0
  )
    return "application/msword";
  return null;
}

// ─── JPEG ────────────────────────────────────────────────────────────────────

/**
 * Walk the JPEG marker chain. Every segment must be reachable from the previous
 * one, the file must end at an EOI, and the SOFn frame header supplies the real
 * dimensions. A file whose markers do not chain (i.e. a JPEG header glued onto
 * some other payload) fails here even though its magic bytes are perfect.
 */
function inspectJpeg(
  input: DeepInspectInput,
  base: DeepInspectResult
): DeepInspectResult {
  const b = input.head;
  const out: DeepInspectResult = {
    ...base,
    detectedMime: "image/jpeg",
    metadata: [],
  };

  need(b, 0, 2, "SOI");
  if (b[0] !== 0xff || b[1] !== 0xd8) {
    reject("SIGNATURE_MISMATCH", "missing JPEG SOI marker");
  }

  let p = 2;
  let sawSof = false;
  let end = -1;
  let nodes = 0;

  while (p < b.length) {
    if (++nodes > 65_535)
      reject("MALFORMED_CONTAINER", "JPEG marker count exceeded");

    // Markers may be preceded by any number of 0xFF fill bytes.
    while (p < b.length && b[p] === 0xff && b[p + 1] === 0xff) p++;
    if (p + 1 >= b.length) reject("TRUNCATED", "JPEG ended mid-marker");
    if (b[p] !== 0xff) reject("MALFORMED_CONTAINER", `expected marker at ${p}`);

    const marker = b[p + 1]!;
    p += 2;

    if (marker === 0xd9) {
      end = p; // EOI
      break;
    }
    // Standalone markers carry no length payload.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;

    need(b, p, 2, "JPEG segment length");
    const segLen = b.readUInt16BE(p);
    if (segLen < 2)
      reject("MALFORMED_CONTAINER", `JPEG segment length ${segLen} at ${p}`);
    const payload = b.subarray(p + 2, Math.min(p + segLen, b.length));

    // SOFn — the frame header. C4/C8/CC are DHT/JPG/DAC, not frame headers.
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      need(b, p + 2, 6, "SOFn");
      out.height = b.readUInt16BE(p + 3);
      out.width = b.readUInt16BE(p + 5);
      sawSof = true;
    }

    if (marker === 0xe1) noteApp1(payload, out.metadata);
    if (
      marker === 0xe2 &&
      payload.subarray(0, 11).toString("latin1") === "ICC_PROFILE"
    ) {
      pushOnce(out.metadata, "icc");
    }
    if (
      marker === 0xed &&
      payload.subarray(0, 13).toString("latin1") === "Photoshop 3.0"
    ) {
      pushOnce(out.metadata, "iptc");
    }

    p += segLen;

    // SOS is followed by entropy-coded data with no length; scan for the next
    // real marker (0xFF00 is a stuffed byte, RSTn are in-stream restarts).
    if (marker === 0xda) {
      p = skipEntropyCoded(b, p);
    }
  }

  if (!sawSof)
    reject("MALFORMED_CONTAINER", "no JPEG frame header (SOFn) found");
  if (end < 0) reject("TRUNCATED", "no JPEG EOI marker found");
  if (input.complete)
    out.trailingBytes = measureTrailing(b, end, input.totalSize);
  return out;
}

function skipEntropyCoded(b: Buffer, from: number): number {
  let p = from;
  while (p + 1 < b.length) {
    if (b[p] === 0xff) {
      const next = b[p + 1]!;
      if (next !== 0x00 && next !== 0xff && !(next >= 0xd0 && next <= 0xd7))
        return p;
    }
    p++;
  }
  return b.length;
}

/** APP1 carries either EXIF (with an optional GPS IFD) or XMP. */
function noteApp1(payload: Buffer, metadata: string[]): void {
  const tag = payload.subarray(0, 6).toString("latin1");
  if (tag === "Exif\0\0") {
    pushOnce(metadata, "exif");
    if (hasGpsIfd(payload.subarray(6))) pushOnce(metadata, "gps");
    return;
  }
  if (
    payload
      .subarray(0, 28)
      .toString("latin1")
      .startsWith("http://ns.adobe.com/xap/")
  ) {
    pushOnce(metadata, "xmp");
  }
}

/**
 * Look for the GPS IFD pointer (TIFF tag 0x8825) in IFD0. Parsing only IFD0's
 * entry table is enough — the GPS block is always referenced from there — and it
 * avoids following attacker-controlled offsets into the rest of the file.
 */
function hasGpsIfd(tiff: Buffer): boolean {
  if (tiff.length < 8) return false;
  const le = tiff[0] === 0x49 && tiff[1] === 0x49;
  const be = tiff[0] === 0x4d && tiff[1] === 0x4d;
  if (!le && !be) return false;
  const u16 = (o: number): number =>
    le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o);
  const u32 = (o: number): number =>
    le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o);

  const ifd0 = u32(4);
  if (ifd0 + 2 > tiff.length) return false;
  const count = u16(ifd0);
  // 12 bytes per entry; cap the walk so a forged count cannot spin us.
  const entries = Math.min(count, 512);
  for (let i = 0; i < entries; i++) {
    const at = ifd0 + 2 + i * 12;
    if (at + 12 > tiff.length) return false;
    if (u16(at) === 0x8825) return true;
  }
  return false;
}

function pushOnce(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}

// ─── PNG ─────────────────────────────────────────────────────────────────────

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function inspectPng(
  input: DeepInspectInput,
  base: DeepInspectResult,
  limits: MediaStructuralLimits
): DeepInspectResult {
  const b = input.head;
  const out: DeepInspectResult = {
    ...base,
    detectedMime: "image/png",
    metadata: [],
  };

  need(b, 0, 8, "PNG signature");
  if (!b.subarray(0, 8).equals(PNG_SIGNATURE)) {
    reject("SIGNATURE_MISMATCH", "missing PNG signature");
  }

  let p = 8;
  let sawIhdr = false;
  let end = -1;
  let nodes = 0;

  while (p + 8 <= b.length) {
    if (++nodes > limits.maxContainerNodes) {
      reject("MALFORMED_CONTAINER", "PNG chunk count exceeded");
    }
    const len = b.readUInt32BE(p);
    const type = ascii(b, p + 4, 4);
    // 2^31-1 is the spec ceiling; anything beyond is a forged length.
    if (len > 0x7fffffff)
      reject("MALFORMED_CONTAINER", `PNG chunk ${type} length ${len}`);
    const dataAt = p + 8;
    if (dataAt + len + 4 > b.length) {
      reject(
        "TRUNCATED",
        `PNG chunk ${type} claims ${len}B beyond end of file`
      );
    }

    if (type === "IHDR") {
      if (sawIhdr) reject("MALFORMED_CONTAINER", "duplicate PNG IHDR");
      need(b, dataAt, 13, "IHDR");
      out.width = b.readUInt32BE(dataAt);
      out.height = b.readUInt32BE(dataAt + 4);
      sawIhdr = true;
    } else if (!sawIhdr) {
      reject("MALFORMED_CONTAINER", `PNG chunk ${type} precedes IHDR`);
    }

    if (type === "acTL") {
      need(b, dataAt, 4, "acTL");
      out.frames = b.readUInt32BE(dataAt); // APNG num_frames
    }
    if (type === "eXIf") pushOnce(out.metadata, "exif");
    if (type === "iCCP") pushOnce(out.metadata, "icc");
    if (type === "tEXt" || type === "zTXt" || type === "iTXt") {
      pushOnce(out.metadata, "text");
      if (
        type === "iTXt" &&
        b
          .subarray(dataAt, dataAt + len)
          .includes(Buffer.from("XML:com.adobe.xmp"))
      ) {
        pushOnce(out.metadata, "xmp");
      }
    }

    p = dataAt + len + 4;
    if (type === "IEND") {
      end = p;
      break;
    }
  }

  if (!sawIhdr) reject("MALFORMED_CONTAINER", "no PNG IHDR chunk");
  if (end < 0) reject("TRUNCATED", "no PNG IEND chunk found");
  if (input.complete)
    out.trailingBytes = measureTrailing(b, end, input.totalSize);
  return out;
}

// ─── GIF ─────────────────────────────────────────────────────────────────────

/**
 * Walk the GIF block stream. This is what makes a frame count possible without
 * decoding: every frame is announced by its own Image Descriptor (0x2C), so a
 * "10 pixel, 200 000 frame" animation is rejected on the count alone.
 */
function inspectGif(
  input: DeepInspectInput,
  base: DeepInspectResult,
  limits: MediaStructuralLimits
): DeepInspectResult {
  const b = input.head;
  const out: DeepInspectResult = {
    ...base,
    detectedMime: "image/gif",
    metadata: [],
    frames: 0,
  };

  need(b, 0, 13, "GIF header");
  const version = ascii(b, 0, 6);
  if (version !== "GIF87a" && version !== "GIF89a") {
    reject("SIGNATURE_MISMATCH", `unknown GIF version "${version}"`);
  }
  out.width = b.readUInt16LE(6);
  out.height = b.readUInt16LE(8);

  let p = 13;
  const packed = b[10]!;
  if (packed & 0x80) p += 3 * (1 << ((packed & 0x07) + 1)); // global colour table

  let end = -1;
  let nodes = 0;

  while (p < b.length) {
    if (++nodes > limits.maxContainerNodes) {
      reject("MALFORMED_CONTAINER", "GIF block count exceeded");
    }
    const blockType = b[p]!;

    if (blockType === 0x3b) {
      end = p + 1; // trailer
      break;
    }

    if (blockType === 0x2c) {
      // Image descriptor = one frame.
      need(b, p, 10, "GIF image descriptor");
      out.frames = (out.frames ?? 0) + 1;
      if (out.frames > limits.maxAnimationFrames) {
        reject(
          "FRAMES_EXCEEDED",
          `GIF frame count exceeded ${limits.maxAnimationFrames}`
        );
      }
      const localPacked = b[p + 9]!;
      p += 10;
      if (localPacked & 0x80) p += 3 * (1 << ((localPacked & 0x07) + 1));
      need(b, p, 1, "GIF LZW min code size");
      p += 1; // LZW minimum code size
      p = skipGifSubBlocks(b, p);
      continue;
    }

    if (blockType === 0x21) {
      need(b, p, 2, "GIF extension");
      const label = b[p + 1]!;
      if (label === 0xfe) pushOnce(out.metadata, "comment");
      if (label === 0xff) pushOnce(out.metadata, "application");
      p += 2;
      p = skipGifSubBlocks(b, p);
      continue;
    }

    reject(
      "MALFORMED_CONTAINER",
      `unknown GIF block 0x${blockType.toString(16)} at ${p}`
    );
  }

  if (end < 0) reject("TRUNCATED", "no GIF trailer found");
  if ((out.frames ?? 0) === 0)
    reject("MALFORMED_CONTAINER", "GIF contains no image data");
  if (input.complete)
    out.trailingBytes = measureTrailing(b, end, input.totalSize);
  return out;
}

function skipGifSubBlocks(b: Buffer, from: number): number {
  let p = from;
  for (let guard = 0; guard < 100_000; guard++) {
    need(b, p, 1, "GIF sub-block size");
    const size = b[p]!;
    if (size === 0) return p + 1;
    p += 1 + size;
  }
  return reject("MALFORMED_CONTAINER", "GIF sub-block chain did not terminate");
}

// ─── WebP ────────────────────────────────────────────────────────────────────

function inspectWebp(
  input: DeepInspectInput,
  base: DeepInspectResult,
  limits: MediaStructuralLimits
): DeepInspectResult {
  const b = input.head;
  const out: DeepInspectResult = {
    ...base,
    detectedMime: "image/webp",
    metadata: [],
  };

  need(b, 0, 12, "RIFF/WEBP header");
  if (ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WEBP") {
    reject("SIGNATURE_MISMATCH", "not a RIFF/WEBP container");
  }
  const riffSize = b.readUInt32LE(4);
  const declaredEnd = riffSize + 8;
  if (input.complete && declaredEnd > input.totalSize) {
    reject(
      "TRUNCATED",
      `RIFF declares ${declaredEnd}B, object is ${input.totalSize}B`
    );
  }

  let p = 12;
  let animated = false;
  let frames = 0;
  let nodes = 0;
  const limit = Math.min(b.length, declaredEnd);

  while (p + 8 <= limit) {
    if (++nodes > limits.maxContainerNodes) {
      reject("MALFORMED_CONTAINER", "WebP chunk count exceeded");
    }
    const fourcc = ascii(b, p, 4);
    const size = b.readUInt32LE(p + 4);
    const dataAt = p + 8;
    if (size > 0x7fffffff || dataAt + size > limit) {
      reject(
        "TRUNCATED",
        `WebP chunk ${fourcc} claims ${size}B beyond container`
      );
    }

    if (fourcc === "VP8X") {
      need(b, dataAt, 10, "VP8X");
      animated = (b[dataAt]! & 0x02) !== 0;
      out.width = readUInt24LE(b, dataAt + 4) + 1;
      out.height = readUInt24LE(b, dataAt + 7) + 1;
    } else if (fourcc === "VP8 " && out.width == null) {
      need(b, dataAt, 10, "VP8");
      out.width = b.readUInt16LE(dataAt + 6) & 0x3fff;
      out.height = b.readUInt16LE(dataAt + 8) & 0x3fff;
    } else if (fourcc === "VP8L" && out.width == null) {
      need(b, dataAt, 5, "VP8L");
      const bits = b.readUInt32LE(dataAt + 1);
      out.width = (bits & 0x3fff) + 1;
      out.height = ((bits >> 14) & 0x3fff) + 1;
    } else if (fourcc === "ANMF") {
      frames++;
      if (frames > limits.maxAnimationFrames) {
        reject(
          "FRAMES_EXCEEDED",
          `animated WebP frame count exceeded ${limits.maxAnimationFrames}`
        );
      }
    } else if (fourcc === "EXIF") {
      pushOnce(out.metadata, "exif");
    } else if (fourcc === "XMP ") {
      pushOnce(out.metadata, "xmp");
    } else if (fourcc === "ICCP") {
      pushOnce(out.metadata, "icc");
    }

    p = dataAt + size + (size % 2); // chunks are padded to an even length
  }

  if (out.width == null)
    reject("MALFORMED_CONTAINER", "no WebP image chunk found");
  if (animated || frames > 0) out.frames = frames;
  if (input.complete)
    out.trailingBytes = measureTrailing(b, declaredEnd, input.totalSize);
  return out;
}

const readUInt24LE = (b: Buffer, o: number): number =>
  b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16);

// ─── ISO base media (MP4 / MOV / M4A / HEIC / HEIF / AVIF) ───────────────────

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
const AVIF_BRANDS = new Set(["avif", "avis"]);

function isobmffMimeForBrands(b: Buffer): string {
  const brands: string[] = [];
  if (b.length >= 12) brands.push(ascii(b, 8, 4));
  const size = b.length >= 4 ? b.readUInt32BE(0) : 0;
  for (let o = 16; o + 4 <= Math.min(size, b.length); o += 4)
    brands.push(ascii(b, o, 4));

  if (brands.some((x) => AVIF_BRANDS.has(x))) return "image/avif";
  if (brands.some((x) => HEIF_BRANDS.has(x))) return "image/heic";
  if (brands.some((x) => x === "qt  ")) return "video/quicktime";
  if (brands.some((x) => x === "M4A " || x === "M4B ")) return "audio/mp4";
  return "video/mp4";
}

/**
 * Walk the box tree. `moov/mvhd` gives duration, `moov/trak/tkhd` gives track
 * dimensions, and for HEIF the still-image size lives in `meta/iprp/ipco/ispe`.
 * Only container boxes are descended into; leaf payloads are skipped, so the
 * work is proportional to the box count, not the file size.
 */
function inspectIsobmff(
  input: DeepInspectInput,
  base: DeepInspectResult,
  limits: MediaStructuralLimits
): DeepInspectResult {
  const b = input.head;
  need(b, 0, 12, "ftyp");

  // A classic QuickTime movie has no `ftyp` box at all (see `isClassicQuickTime`
  // in magic-bytes.ts) — its first atom is moov/mdat/wide/free. That layout is
  // only valid for video/quicktime; everything else in this family must lead
  // with ftyp.
  const hasFtyp = ascii(b, 4, 4) === "ftyp";
  if (!hasFtyp && !isClassicQuickTime(b)) {
    reject(
      "SIGNATURE_MISMATCH",
      "ISO base media file must start with an ftyp box"
    );
  }

  const out: DeepInspectResult = {
    ...base,
    detectedMime: hasFtyp ? isobmffMimeForBrands(b) : "video/quicktime",
    metadata: [],
  };

  const state = { nodes: 0 };
  walkBoxes(b, 0, b.length, 0, out, limits, state);

  // A non-faststart MP4 keeps `moov` at the very end. Probe the tail window too
  // rather than declaring the duration unknown (which would skip the limit).
  if (input.tail && (out.durationMs == null || out.width == null)) {
    walkBoxes(
      input.tail,
      0,
      input.tail.length,
      0,
      out,
      limits,
      { nodes: 0 },
      true
    );
  }

  return out;
}

const CONTAINER_BOXES = new Set([
  "moov",
  "trak",
  "mdia",
  "minf",
  "stbl",
  "edts",
  "udta",
  "meta",
  "iprp",
  "ipco",
  "moof",
  "traf",
  "mvex",
  "dinf",
]);

function walkBoxes(
  b: Buffer,
  start: number,
  end: number,
  depth: number,
  out: DeepInspectResult,
  limits: MediaStructuralLimits,
  state: { nodes: number },
  lenient = false
): void {
  if (depth > limits.maxContainerDepth) return;
  let p = start;

  while (p + 8 <= end) {
    if (++state.nodes > limits.maxContainerNodes) {
      reject("MALFORMED_CONTAINER", "ISOBMFF box count exceeded");
    }
    let size = b.readUInt32BE(p);
    const type = ascii(b, p + 4, 4);
    let headerLen = 8;

    if (size === 1) {
      if (p + 16 > end) break;
      const hi = b.readUInt32BE(p + 8);
      const lo = b.readUInt32BE(p + 12);
      size = hi * 0x1_0000_0000 + lo;
      headerLen = 16;
    } else if (size === 0) {
      size = end - p; // extends to end of file
    }

    if (size < headerLen) {
      // A zero/negative-advance box is how a hostile file pins the parser.
      if (lenient) return;
      reject("MALFORMED_CONTAINER", `ISOBMFF box ${type} has size ${size}`);
    }
    const bodyAt = p + headerLen;
    const bodyEnd = Math.min(p + size, end);

    if (type === "mvhd") readMvhd(b, bodyAt, bodyEnd, out);
    else if (type === "tkhd") readTkhd(b, bodyAt, bodyEnd, out);
    else if (type === "ispe") readIspe(b, bodyAt, bodyEnd, out);
    else if (type === "mdhd") readMdhd(b, bodyAt, bodyEnd, out);
    else if (type === "uuid" || type === "xml ") pushOnce(out.metadata, "xmp");
    else if (type === "Exif" || type === "exif") pushOnce(out.metadata, "exif");
    else if (CONTAINER_BOXES.has(type)) {
      // `meta` is a FullBox: 4 bytes of version+flags precede its children.
      const childStart = type === "meta" ? bodyAt + 4 : bodyAt;
      walkBoxes(b, childStart, bodyEnd, depth + 1, out, limits, state, lenient);
    }

    p += size;
  }
}

function readMvhd(
  b: Buffer,
  at: number,
  end: number,
  out: DeepInspectResult
): void {
  if (at + 4 > end) return;
  const version = b[at]!;
  if (version === 1) {
    if (at + 28 > end) return;
    const timescale = b.readUInt32BE(at + 20);
    const hi = b.readUInt32BE(at + 24);
    const lo = at + 32 <= end ? b.readUInt32BE(at + 28) : 0;
    const duration = hi * 0x1_0000_0000 + lo;
    if (timescale > 0) out.durationMs = (duration / timescale) * 1000;
  } else {
    if (at + 20 > end) return;
    const timescale = b.readUInt32BE(at + 12);
    const duration = b.readUInt32BE(at + 16);
    if (timescale > 0) out.durationMs = (duration / timescale) * 1000;
  }
}

function readMdhd(
  b: Buffer,
  at: number,
  end: number,
  out: DeepInspectResult
): void {
  if (out.durationMs != null) return;
  readMvhd(b, at, end, out); // identical layout for the fields we read
}

function readTkhd(
  b: Buffer,
  at: number,
  end: number,
  out: DeepInspectResult
): void {
  const version = b[at]!;
  // Trailing 8 bytes of a tkhd are width/height as 16.16 fixed point.
  const size = version === 1 ? 92 : 80;
  if (at + size > end) return;
  const w = b.readUInt32BE(at + size - 8) / 65536;
  const h = b.readUInt32BE(at + size - 4) / 65536;
  // Audio and hint tracks carry 0x0; only take a real visual track.
  if (w >= 1 && h >= 1) {
    out.width = Math.max(out.width ?? 0, Math.round(w));
    out.height = Math.max(out.height ?? 0, Math.round(h));
  }
}

function readIspe(
  b: Buffer,
  at: number,
  end: number,
  out: DeepInspectResult
): void {
  if (at + 12 > end) return;
  const w = b.readUInt32BE(at + 4);
  const h = b.readUInt32BE(at + 8);
  out.width = Math.max(out.width ?? 0, w);
  out.height = Math.max(out.height ?? 0, h);
}

// ─── Matroska / WebM ─────────────────────────────────────────────────────────

function inspectMatroska(
  input: DeepInspectInput,
  base: DeepInspectResult,
  limits: MediaStructuralLimits
): DeepInspectResult {
  const b = input.head;
  need(b, 0, 4, "EBML header");
  if (b[0] !== 0x1a || b[1] !== 0x45 || b[2] !== 0xdf || b[3] !== 0xa3) {
    reject("SIGNATURE_MISMATCH", "missing EBML header");
  }

  const out: DeepInspectResult = {
    ...base,
    detectedMime: "video/x-matroska",
    metadata: [],
  };
  const state = { nodes: 0, timecodeScale: 1_000_000, durationTicks: 0 };
  walkEbml(b, 0, b.length, 0, out, limits, state);
  if (state.durationTicks > 0) {
    out.durationMs = (state.durationTicks * state.timecodeScale) / 1_000_000;
  }
  return out;
}

/** EBML master elements we descend into. */
const EBML_MASTERS = new Set([
  0x1a45dfa3, // EBML header
  0x18538067, // Segment
  0x1549a966, // Info
  0x1654ae6b, // Tracks
  0xae, // TrackEntry
  0xe0, // Video
]);

function walkEbml(
  b: Buffer,
  start: number,
  end: number,
  depth: number,
  out: DeepInspectResult,
  limits: MediaStructuralLimits,
  state: { nodes: number; timecodeScale: number; durationTicks: number }
): void {
  if (depth > limits.maxContainerDepth) return;
  let p = start;

  while (p < end) {
    if (++state.nodes > limits.maxContainerNodes) return;
    const id = readVint(b, p, true);
    if (!id) return;
    const sizeField = readVint(b, p + id.length, false);
    if (!sizeField) return;

    const bodyAt = p + id.length + sizeField.length;
    // "Unknown size" (all bits set) means "to the end of the parent".
    const body = sizeField.unknown ? end - bodyAt : sizeField.value;
    const bodyEnd = Math.min(bodyAt + body, end);
    if (bodyEnd <= bodyAt && !sizeField.unknown) {
      p = bodyAt;
      continue;
    }

    switch (id.value) {
      case 0x2ad7b1: // TimecodeScale
        state.timecodeScale =
          readUIntBE(b, bodyAt, bodyEnd - bodyAt) || 1_000_000;
        break;
      case 0x4489: // Duration (IEEE float)
        state.durationTicks = readEbmlFloat(b, bodyAt, bodyEnd - bodyAt);
        break;
      case 0xb0: // PixelWidth
        out.width = Math.max(
          out.width ?? 0,
          readUIntBE(b, bodyAt, bodyEnd - bodyAt)
        );
        break;
      case 0xba: // PixelHeight
        out.height = Math.max(
          out.height ?? 0,
          readUIntBE(b, bodyAt, bodyEnd - bodyAt)
        );
        break;
      case 0x4282: // DocType
        out.detectedMime =
          ascii(b, bodyAt, bodyEnd - bodyAt).replace(/\0+$/, "") === "webm"
            ? "video/webm"
            : "video/x-matroska";
        break;
      default:
        break;
    }

    if (EBML_MASTERS.has(id.value)) {
      walkEbml(b, bodyAt, bodyEnd, depth + 1, out, limits, state);
    }
    // Clusters are the bulk of the file and hold nothing we need — skipping
    // them is what keeps this bounded on a 100 MB WebM.
    p = bodyEnd;
    if (p <= bodyAt && !sizeField.unknown) return;
  }
}

interface Vint {
  value: number;
  length: number;
  unknown: boolean;
}

function readVint(b: Buffer, at: number, keepMarker: boolean): Vint | null {
  if (at >= b.length) return null;
  const first = b[at]!;
  if (first === 0) return null;
  let length = 1;
  let mask = 0x80;
  while (length <= 8 && (first & mask) === 0) {
    mask >>= 1;
    length++;
  }
  if (length > 8 || at + length > b.length) return null;

  let value = keepMarker ? first : first & (mask - 1);
  let allOnes = (first & (mask - 1)) === mask - 1;
  for (let i = 1; i < length; i++) {
    const byte = b[at + i]!;
    value = value * 256 + byte;
    if (byte !== 0xff) allOnes = false;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

function readUIntBE(b: Buffer, at: number, len: number): number {
  if (len <= 0 || at + len > b.length || len > 8) return 0;
  let value = 0;
  for (let i = 0; i < len; i++) value = value * 256 + b[at + i]!;
  return value;
}

function readEbmlFloat(b: Buffer, at: number, len: number): number {
  if (len === 4 && at + 4 <= b.length) return b.readFloatBE(at);
  if (len === 8 && at + 8 <= b.length) return b.readDoubleBE(at);
  return 0;
}

// ─── Ogg ─────────────────────────────────────────────────────────────────────

function inspectOgg(
  input: DeepInspectInput,
  base: DeepInspectResult
): DeepInspectResult {
  const b = input.head;
  need(b, 0, 27, "Ogg page header");
  if (ascii(b, 0, 4) !== "OggS")
    reject("SIGNATURE_MISMATCH", "missing OggS capture pattern");

  const out: DeepInspectResult = {
    ...base,
    detectedMime: "audio/ogg",
    metadata: [],
  };

  // Codec identification lives in the first packet of the first page.
  const idx = b.indexOf(Buffer.from("OpusHead"));
  let rate = 48_000;
  if (idx >= 0 && idx + 16 <= b.length) {
    rate = 48_000; // Opus granule positions are always in 48 kHz units
  } else {
    const vorbis = b.indexOf(
      Buffer.from([0x01, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73])
    );
    if (vorbis >= 0 && vorbis + 16 <= b.length)
      rate = b.readUInt32LE(vorbis + 12) || 48_000;
    else if (b.indexOf(Buffer.from("OggS")) !== 0) {
      reject("MALFORMED_CONTAINER", "no recognised Ogg codec header");
    }
  }

  // The last page's granule position is the total sample count. Look in the tail
  // window when we have one, otherwise in whatever head we were given.
  const search = input.tail ?? b;
  const lastPage = search.lastIndexOf(Buffer.from("OggS"));
  if (lastPage >= 0 && lastPage + 14 <= search.length) {
    const granule =
      search.readUInt32LE(lastPage + 6) +
      search.readUInt32LE(lastPage + 10) * 0x1_0000_0000;
    if (granule > 0 && rate > 0) out.durationMs = (granule / rate) * 1000;
  }
  return out;
}

// ─── WAV ─────────────────────────────────────────────────────────────────────

function inspectWav(
  input: DeepInspectInput,
  base: DeepInspectResult
): DeepInspectResult {
  const b = input.head;
  need(b, 0, 12, "RIFF/WAVE header");
  if (ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WAVE") {
    reject("SIGNATURE_MISMATCH", "not a RIFF/WAVE container");
  }
  const out: DeepInspectResult = {
    ...base,
    detectedMime: "audio/wav",
    metadata: [],
  };

  let p = 12;
  let byteRate = 0;
  let sawFmt = false;
  while (p + 8 <= b.length) {
    const id = ascii(b, p, 4);
    const size = b.readUInt32LE(p + 4);
    const dataAt = p + 8;
    if (size > 0x7fffffff)
      reject("MALFORMED_CONTAINER", `WAV chunk ${id} size ${size}`);

    if (id === "fmt " && dataAt + 16 <= b.length) {
      byteRate = b.readUInt32LE(dataAt + 8);
      sawFmt = true;
    } else if (id === "data") {
      if (byteRate > 0) out.durationMs = (size / byteRate) * 1000;
      break;
    } else if (id === "LIST" || id === "id3 ") {
      pushOnce(out.metadata, "text");
    }
    p = dataAt + size + (size % 2);
  }
  if (!sawFmt) reject("MALFORMED_CONTAINER", "WAV has no fmt chunk");
  return out;
}

// ─── FLAC ────────────────────────────────────────────────────────────────────

function inspectFlac(
  input: DeepInspectInput,
  base: DeepInspectResult
): DeepInspectResult {
  const b = input.head;
  need(b, 0, 42, "FLAC STREAMINFO");
  if (ascii(b, 0, 4) !== "fLaC")
    reject("SIGNATURE_MISMATCH", "missing fLaC marker");

  const out: DeepInspectResult = {
    ...base,
    detectedMime: "audio/flac",
    metadata: [],
  };
  // Block header at 4 (1 byte type + 3 byte length), STREAMINFO body at 8.
  if ((b[4]! & 0x7f) !== 0)
    reject("MALFORMED_CONTAINER", "first FLAC block is not STREAMINFO");
  const s = 8;
  // sample rate = 20 bits starting at byte 10 of STREAMINFO
  const sampleRate = (b[s + 10]! << 12) | (b[s + 11]! << 4) | (b[s + 12]! >> 4);
  // total samples = 36 bits: low nibble of byte 12 + bytes 13..16
  const totalSamples =
    (b[s + 12]! & 0x0f) * 0x1_0000_0000 +
    b[s + 13]! * 0x100_0000 +
    b[s + 14]! * 0x1_0000 +
    b[s + 15]! * 0x100 +
    b[s + 16]!;
  if (sampleRate <= 0)
    reject("MALFORMED_CONTAINER", "FLAC sample rate is zero");
  if (totalSamples > 0) out.durationMs = (totalSamples / sampleRate) * 1000;
  return out;
}

// ─── MP3 ─────────────────────────────────────────────────────────────────────

const MP3_BITRATES_V1L3 = [
  0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0,
];
const MP3_SAMPLE_RATES = [44_100, 48_000, 32_000, 0];

function inspectMp3(
  input: DeepInspectInput,
  base: DeepInspectResult
): DeepInspectResult {
  const b = input.head;
  const out: DeepInspectResult = {
    ...base,
    detectedMime: "audio/mpeg",
    metadata: [],
  };

  let p = 0;
  if (b.length >= 10 && ascii(b, 0, 3) === "ID3") {
    pushOnce(out.metadata, "id3");
    // Syncsafe 28-bit size across bytes 6..9.
    const size = (b[6]! << 21) | (b[7]! << 14) | (b[8]! << 7) | b[9]!;
    p = 10 + size;
  }

  // Find the first real frame header within a bounded window.
  const limit = Math.min(b.length - 4, p + 256 * 1024);
  for (; p <= limit; p++) {
    if (b[p] !== 0xff || (b[p + 1]! & 0xe0) !== 0xe0) continue;
    const versionBits = (b[p + 1]! >> 3) & 0x03;
    const bitrateIdx = (b[p + 2]! >> 4) & 0x0f;
    const rateIdx = (b[p + 2]! >> 2) & 0x03;
    if (
      versionBits === 1 ||
      bitrateIdx === 0 ||
      bitrateIdx === 15 ||
      rateIdx === 3
    )
      continue;

    const kbps = MP3_BITRATES_V1L3[bitrateIdx]!;
    const sampleRate = MP3_SAMPLE_RATES[rateIdx]!;
    if (kbps === 0 || sampleRate === 0) continue;
    // CBR estimate. VBR files report high; the duration cap is generous enough
    // that an over-estimate only ever fails closed on a genuinely long file.
    out.durationMs = ((input.totalSize - p) / ((kbps * 1000) / 8)) * 1000;
    return out;
  }

  return reject("MALFORMED_CONTAINER", "no MPEG audio frame header found");
}

// ─── AAC (ADTS) ──────────────────────────────────────────────────────────────

/**
 * Raw AAC has no file-level header, only a repeating 0xFFF ADTS sync word —
 * which is why it had an empty magic-byte accept-set. Requiring TWO chained
 * frames (the second sync word must land exactly where the first frame's length
 * says it will) is a signature in practice: random bytes do not chain.
 */
function inspectAac(
  input: DeepInspectInput,
  base: DeepInspectResult
): DeepInspectResult {
  const b = input.head;
  const out: DeepInspectResult = {
    ...base,
    detectedMime: "audio/aac",
    metadata: [],
  };

  let p = 0;
  if (b.length >= 10 && ascii(b, 0, 3) === "ID3") {
    pushOnce(out.metadata, "id3");
    p = 10 + ((b[6]! << 21) | (b[7]! << 14) | (b[8]! << 7) | b[9]!);
  }

  const limit = Math.min(b.length - 7, p + 64 * 1024);
  for (; p <= limit; p++) {
    if (b[p] !== 0xff || (b[p + 1]! & 0xf0) !== 0xf0) continue;
    const frameLen =
      ((b[p + 3]! & 0x03) << 11) | (b[p + 4]! << 3) | (b[p + 5]! >> 5);
    if (frameLen < 7) continue;
    const next = p + frameLen;
    if (next + 2 > b.length) continue;
    if (b[next] === 0xff && (b[next + 1]! & 0xf0) === 0xf0) return out;
  }
  return reject("SIGNATURE_MISMATCH", "no chained ADTS frames found");
}

// ─── AVI ─────────────────────────────────────────────────────────────────────

/**
 * AVI also had an empty accept-set. It is a RIFF container, so `RIFF....AVI `
 * plus a walkable `hdrl` list is a perfectly good signature — and `avih` gives
 * duration and dimensions for free.
 */
function inspectAvi(
  input: DeepInspectInput,
  base: DeepInspectResult,
  limits: MediaStructuralLimits
): DeepInspectResult {
  const b = input.head;
  need(b, 0, 12, "RIFF/AVI header");
  if (ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "AVI ") {
    reject("SIGNATURE_MISMATCH", "not a RIFF/AVI container");
  }
  const out: DeepInspectResult = {
    ...base,
    detectedMime: "video/x-msvideo",
    metadata: [],
  };

  // hdrl/avih sits immediately inside the first LIST.
  const avih = b.indexOf(Buffer.from("avih"));
  if (avih < 0 || avih + 40 > b.length) {
    reject("MALFORMED_CONTAINER", "AVI has no avih header");
  }
  const microSecPerFrame = b.readUInt32LE(avih + 8);
  const totalFrames = b.readUInt32LE(avih + 20);
  out.width = b.readUInt32LE(avih + 36);
  out.height = b.readUInt32LE(avih + 40);
  if (microSecPerFrame > 0 && totalFrames > 0) {
    out.durationMs = (microSecPerFrame * totalFrames) / 1000;
  }
  void limits;
  return out;
}

// ─── PDF ─────────────────────────────────────────────────────────────────────

/**
 * PDF is a scripting host. Rejecting the active-content constructs outright is
 * the only defence available without a full parser, and it costs nothing for the
 * documents people actually send each other.
 */
const PDF_ACTIVE_CONTENT: Array<[string, string]> = [
  ["/JavaScript", "embedded JavaScript"],
  ["/JS", "embedded JavaScript"],
  ["/OpenAction", "automatic action on open"],
  ["/AA", "additional (event) actions"],
  ["/Launch", "launch action"],
  ["/EmbeddedFile", "embedded file"],
  ["/RichMedia", "rich media (Flash) annotation"],
  ["/XFA", "XFA form"],
];

function inspectPdf(
  input: DeepInspectInput,
  base: DeepInspectResult
): DeepInspectResult {
  const b = input.head;
  need(b, 0, 5, "PDF header");
  if (ascii(b, 0, 5) !== "%PDF-")
    reject("SIGNATURE_MISMATCH", "missing %PDF- header");

  const out: DeepInspectResult = {
    ...base,
    detectedMime: "application/pdf",
    metadata: [],
  };

  const eof = b.lastIndexOf(Buffer.from("%%EOF"));
  if (eof < 0) reject("TRUNCATED", "PDF has no %%EOF marker");
  if (input.complete) {
    // A PDF reader ignores bytes after the LAST %%EOF, so that is where a
    // polyglot payload is parked. Allow the customary EOL bytes only.
    out.trailingBytes = measureTrailing(b, eof + 5, input.totalSize);
  }

  for (const [needle, label] of PDF_ACTIVE_CONTENT) {
    if (b.includes(Buffer.from(needle))) {
      reject("SUSPICIOUS_CONTENT", `PDF contains ${label} (${needle})`);
    }
  }
  return out;
}

// ─── Textual formats ─────────────────────────────────────────────────────────

/**
 * text/plain, text/csv, application/json and application/xml previously had
 * EMPTY magic-byte accept-sets — declaring one of them skipped every content
 * check, which made "declare text/plain, upload anything" the single widest hole
 * in the pipeline. Text has no signature, but it does have a strong negative
 * one: real text is valid UTF-8, contains no NUL bytes, and does not begin with
 * another format's magic number.
 */
const SCRIPT_MARKERS: Array<[string, string]> = [
  ["<script", "HTML script tag"],
  ["<!doctype html", "HTML document"],
  ["<html", "HTML document"],
  ["<?php", "PHP source"],
  ["<svg", "SVG document"],
  ["<!entity", "XML entity declaration"],
  ["<!doctype", "XML DOCTYPE"],
];

function inspectTextual(
  input: DeepInspectInput,
  base: DeepInspectResult,
  mime: string
): DeepInspectResult {
  const b = input.head;
  const out: DeepInspectResult = { ...base, detectedMime: mime, metadata: [] };

  const sniffed = sniff(b);
  if (sniffed && !sniffed.startsWith("text/")) {
    reject(
      "SIGNATURE_MISMATCH",
      `declared ${mime} but the bytes are ${sniffed}`
    );
  }
  if (b.includes(0x00)) {
    reject("SIGNATURE_MISMATCH", `declared ${mime} but the bytes contain NUL`);
  }

  const text = b.toString("utf8");
  // Buffer#toString substitutes U+FFFD for invalid sequences; a real text file
  // that is mostly replacement characters is not text.
  const replacements = countChar(text, "�");
  if (replacements > 0 && replacements > text.length / 64) {
    reject(
      "SIGNATURE_MISMATCH",
      `declared ${mime} but the bytes are not valid UTF-8`
    );
  }

  const lower = text.slice(0, 64 * 1024).toLowerCase();
  const isXml = mime === "application/xml" || mime === "text/xml";
  for (const [marker, label] of SCRIPT_MARKERS) {
    if (!lower.includes(marker)) continue;
    // A DOCTYPE is legitimate in XML; an ENTITY declaration inside it is the
    // XXE / billion-laughs vector and never is.
    if (isXml && marker === "<!doctype") continue;
    reject("SUSPICIOUS_CONTENT", `${mime} payload contains ${label}`);
  }

  if (mime === "application/json") {
    if (input.complete) {
      try {
        JSON.parse(text);
      } catch (err) {
        reject(
          "MALFORMED_CONTAINER",
          `declared application/json but does not parse: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }
  }
  return out;
}

function countChar(text: string, ch: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text[i] === ch) n++;
  return n;
}

// ─── Metadata stripping ──────────────────────────────────────────────────────

/**
 * Remove metadata containers by byte surgery — no decode, no re-encode.
 *
 * This is deliberately limited to the two formats where a metadata block is a
 * self-describing, length-prefixed unit that can be excised without touching the
 * image data: JPEG APPn segments and PNG ancillary chunks. That covers the case
 * that actually matters in a messaging product — a photo straight off a phone
 * carrying GPS coordinates and a device serial number.
 *
 * Returns the original buffer unchanged when there is nothing to strip or the
 * format is not one of the two, so callers can apply it unconditionally.
 */
export function stripImageMetadata(buf: Buffer, mime: string): Buffer {
  try {
    if (mime === "image/jpeg") return stripJpegMetadata(buf);
    if (mime === "image/png") return stripPngMetadata(buf);
  } catch {
    // Surgery is an enhancement, never a gate: on any doubt keep the original,
    // which the inspector has already validated.
  }
  return buf;
}

/** APPn markers that carry metadata rather than decoder state. */
const JPEG_STRIPPABLE = new Set([
  0xe1, // APP1 — EXIF / XMP
  0xe2, // APP2 — ICC / FlashPix
  0xe3,
  0xe4,
  0xe5,
  0xe6,
  0xe7,
  0xe8,
  0xe9,
  0xea,
  0xeb,
  0xec,
  0xed, // APP13 — IPTC / Photoshop
  0xee,
  0xef,
  0xfe, // COM
]);

function stripJpegMetadata(b: Buffer): Buffer {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return b;
  const keep: Buffer[] = [b.subarray(0, 2)];
  let p = 2;

  while (p + 3 < b.length) {
    if (b[p] !== 0xff) break;
    const marker = b[p + 1]!;
    if (marker === 0xd9) {
      keep.push(b.subarray(p, p + 2)); // EOI — the file ends here
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      keep.push(b.subarray(p, p + 2));
      p += 2;
      continue;
    }
    const segLen = b.readUInt16BE(p + 2);
    if (segLen < 2 || p + 2 + segLen > b.length) break;

    if (!JPEG_STRIPPABLE.has(marker)) keep.push(b.subarray(p, p + 2 + segLen));
    p += 2 + segLen;

    if (marker === 0xda) {
      // Entropy-coded data runs to EOI; copy the remainder verbatim.
      keep.push(b.subarray(p));
      break;
    }
  }
  return Buffer.concat(keep);
}

/** PNG chunks that are safe to drop (ancillary = lower-case first letter). */
const PNG_STRIPPABLE = new Set([
  "eXIf",
  "tEXt",
  "zTXt",
  "iTXt",
  "iCCP",
  "tIME",
]);

function stripPngMetadata(b: Buffer): Buffer {
  if (b.length < 8 || !b.subarray(0, 8).equals(PNG_SIGNATURE)) return b;
  const keep: Buffer[] = [b.subarray(0, 8)];
  let p = 8;

  while (p + 8 <= b.length) {
    const len = b.readUInt32BE(p);
    const type = ascii(b, p + 4, 4);
    const next = p + 8 + len + 4;
    if (len > 0x7fffffff || next > b.length) break;
    if (!PNG_STRIPPABLE.has(type)) keep.push(b.subarray(p, next));
    p = next;
    if (type === "IEND") break;
  }
  return Buffer.concat(keep);
}
