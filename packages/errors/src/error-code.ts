import { AppError } from "./AppError";

const STATUS_CODE: Record<number, string> = {
  400: "BAD_REQUEST",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  410: "GONE",
  415: "UNSUPPORTED_MEDIA_TYPE",
  429: "TOO_MANY_REQUESTS",
};

/**
 * Stable machine-readable error code for an AppError. When `messageKey` is
 * already a code-like token (UPPER_SNAKE_CASE, e.g. "COMMUNITY_JOIN_BANNED")
 * it IS the code; otherwise the key is a human sentence (a validation detail)
 * so fall back to a generic status-based code and leave the sentence as the
 * response `message`. Clients branch on this — a localized `message` cannot be
 * compared against.
 */
export function deriveAppErrorCode(error: AppError): string {
  const key = error.messageKey;
  if (key && /^[A-Z][A-Z0-9_]*$/.test(key)) return key;
  return STATUS_CODE[error.statusCode] ?? "ERROR";
}
