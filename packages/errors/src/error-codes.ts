/**
 * Stable, machine-readable error codes for the HTTP surface.
 *
 * The Socket.IO ack envelope has carried a code + `retryable` flag since it was
 * written (`apps/api-gateway/src/sockets/ack.ts` — `AckErrorCode`,
 * `ACK_RETRYABLE`). The HTTP surface never got one: every service answered
 * `{ success: false, message }` and nothing else, so a client had only the
 * numeric status and an English sentence to branch on. That is why "Something
 * went wrong" became the universal frontend fallback, and why a 429 was
 * indistinguishable from a validation failure at the call site.
 *
 * These names deliberately mirror the socket taxonomy where the concepts
 * overlap (`RATE_LIMITED`, `NOT_FOUND`, `FORBIDDEN`, `CONFLICT`) so a client can
 * share one switch across both transports.
 *
 * NOTE: this is a *transport-level* classification derived from the HTTP status.
 * The domain-level reason stays in `AppError.messageKey` (e.g.
 * `CHAT_MESSAGE_NOT_FOUND`), which the API layer emits alongside as the
 * localized `message`. Do not add domain codes here.
 */
export const API_ERROR_CODES = [
  "BAD_REQUEST",
  "VALIDATION_FAILED",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "GONE",
  "UNSUPPORTED_MEDIA_TYPE",
  "PAYLOAD_TOO_LARGE",
  "RATE_LIMITED",
  "TIMEOUT",
  "SERVER_ERROR",
  "SERVICE_UNAVAILABLE",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

const STATUS_TO_CODE: Record<number, ApiErrorCode> = {
  400: "BAD_REQUEST",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  408: "TIMEOUT",
  409: "CONFLICT",
  410: "GONE",
  413: "PAYLOAD_TOO_LARGE",
  415: "UNSUPPORTED_MEDIA_TYPE",
  422: "VALIDATION_FAILED",
  429: "RATE_LIMITED",
  502: "SERVICE_UNAVAILABLE",
  503: "SERVICE_UNAVAILABLE",
  504: "TIMEOUT",
};

/**
 * Whether re-sending the SAME request could plausibly succeed later.
 *
 * This is a statement about the *server*, not about the operation: a retryable
 * 503 on a non-idempotent POST is still unsafe for a client to retry blindly.
 * Clients must combine this with request safety (see the frontend's
 * `isRetryableRequest`) before auto-retrying anything.
 *
 * 408/429/502/503/504 and any other 5xx are transient. Every 4xx below 408 is
 * caused by the request itself and will fail identically forever.
 */
export function isRetryableStatus(statusCode: number): boolean {
  if (statusCode === 408 || statusCode === 429) return true;
  return statusCode >= 500;
}

/** Map an HTTP status to its stable code. Unknown 4xx → BAD_REQUEST, 5xx → SERVER_ERROR. */
export function resolveErrorCode(statusCode: number): ApiErrorCode {
  const mapped = STATUS_TO_CODE[statusCode];
  if (mapped) return mapped;
  return statusCode >= 500 ? "SERVER_ERROR" : "BAD_REQUEST";
}
