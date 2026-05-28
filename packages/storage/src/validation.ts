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
