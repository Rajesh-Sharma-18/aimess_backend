import { StorageValidationError } from "./types.js";

/** Throws UNSUPPORTED_CONTENT_TYPE when `contentType` is not in `allowed`. */
export function assertAllowedMime(
  contentType: string,
  allowed: string[]
): void {
  if (!allowed.includes(contentType)) {
    throw new StorageValidationError("UNSUPPORTED_CONTENT_TYPE");
  }
}

/** Throws FILE_EMPTY (< 1 byte) or FILE_TOO_LARGE (> max). */
export function assertFileSize(bytes: number, maxBytes: number): void {
  if (bytes < 1) {
    throw new StorageValidationError("FILE_EMPTY");
  }
  if (bytes > maxBytes) {
    throw new StorageValidationError("FILE_TOO_LARGE");
  }
}

/** Characters that must never survive into a stored/served filename: ASCII
 *  control chars (incl. CR/LF), DEL, double-quote and backslash. Built from
 *  char codes to avoid embedding raw control bytes in the source regex. */
const UNSAFE_FILENAME_CHARS = new Set<number>([
  ...Array.from({ length: 0x20 }, (_, i) => i), // 0x00–0x1f control chars
  0x7f, // DEL
  0x22, // "
  0x5c, // backslash
]);

/**
 * Strip directory components, control characters, and header-breaking bytes from
 * a client-supplied filename and cap its length. The result is safe to embed in
 * a `Content-Disposition` header (no CRLF/quote injection) and can never escape
 * its directory. Returns "" for empty / normalized-away input.
 */
export function sanitizeFileName(
  name: string | null | undefined,
  maxLen = 255
): string {
  if (!name) return "";
  // Keep only the basename — handles both POSIX and Windows separators + "..".
  const base = name.split(/[/\\]/).pop() ?? "";
  let cleaned = "";
  for (const ch of base) {
    const code = ch.codePointAt(0) ?? 0;
    if (!UNSAFE_FILENAME_CHARS.has(code)) cleaned += ch;
  }
  return cleaned.trim().slice(0, maxLen);
}

/** Lower-case extension (no leading dot) of a filename, or "" when it has none. */
export function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  if (dot < 0 || dot === fileName.length - 1) return "";
  return fileName.slice(dot + 1).toLowerCase();
}

/**
 * Defense-in-depth: when a client supplies a filename that HAS an extension,
 * ensure it matches the extension the server derives from the declared MIME
 * type. The stored object key always uses the MIME-derived extension regardless,
 * so this only rejects a deceptive `originalFileName` (e.g. an `image/png`
 * upload named `invoice.html`). No-op when the filename has no extension.
 */
export function assertExtensionMatchesMime(
  fileName: string,
  expectedExt: string
): void {
  const ext = extensionOf(fileName);
  const want = expectedExt.replace(/^\./, "").toLowerCase();
  if (ext && ext !== want) {
    throw new StorageValidationError("EXTENSION_MIME_MISMATCH");
  }
}
