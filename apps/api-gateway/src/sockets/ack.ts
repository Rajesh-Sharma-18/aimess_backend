/**
 * Shared Socket.IO ack envelope helpers for every namespace (/chat, /community,
 * /notify). One taxonomy, one `retryable` policy, one localized `message` — so a
 * mobile client can branch on `error`/`retryable` AND surface a ready-to-show
 * sentence identically regardless of which namespace answered.
 *
 * Success: { success: true, message }                       (no data)
 *          { success: true, message, data: <gRPC result> }  (with data)
 * Failure: { success: false, error: <AckErrorCode>, retryable: boolean, message }
 *
 * `message` is resolved here via the shared `t()` catalog so the copy lives in
 * one place (`@aimess/constants` SOCKET_MESSAGES) — callers pass a MessageKey +
 * the per-connection locale, never a raw string.
 */
import {
  currentLocale,
  t,
  type MessageKey,
  type SupportedLocale,
} from "@aimess/constants";

/**
 * The language to answer THIS packet in.
 *
 * Every namespace resolves `socket.data.locale` once, in its `connection`
 * handler, and hands that copy to all ~180 ack sites below. `locale:set` moves
 * the locale of an ALREADY-OPEN connection (Settings → Language, no reconnect),
 * so the copy goes stale the moment a session switches language: the socket's
 * broadcasts moved (they read `socket.data.locale` per emit — see
 * `emit-personalized.ts`) while its acks kept answering in the language the
 * connection had started in.
 *
 * `scopeSocketLocale` installs a `socket.use()` that runs for every INBOUND
 * packet and publishes the LIVE `socket.data.locale` as the ambient locale for
 * the whole handler, so inside a handler the ambient value is by definition
 * this socket's current language — and it is per socket, never per user, so two
 * sessions of one account answering at the same moment answer in their own.
 *
 * The argument stays as the fallback for the rare ack raised outside an inbound
 * packet, where there is no ambient locale to read.
 */
function ackLocale(fallback: SupportedLocale): SupportedLocale {
  return currentLocale(fallback);
}

// Richer ack error taxonomy so clients can distinguish permanent vs transient
// failures (and whether a blind retry is safe).
export type AckErrorCode =
  | "INVALID_PAYLOAD"
  | "SERVICE_ERROR"
  | "FORBIDDEN"
  | "USER_BANNED"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "CONFLICT";

export interface AckError {
  success: false;
  error: AckErrorCode;
  retryable: boolean;
  /** Localized, human-readable explanation for the error (display-ready). */
  message: string;
  /**
   * The originating `AppError.messageKey` when the callee sent one (e.g.
   * "CALL_ALREADY_IN_CALL"). `error` is a deliberately coarse taxonomy —
   * several unrelated failures share one code — so this is the only thing a
   * client can branch on to pick its OWN localized copy or a different UI
   * treatment. Always a short catalog token, never free text (see
   * `MESSAGE_KEY_PATTERN`); absent when the callee sent no key.
   */
  detail?: string;
  /** Seconds until the rate-limit window resets. Present only on RATE_LIMITED. */
  retryAfter?: number;
}

export interface AckSuccess {
  success: true;
  /** Localized, human-readable confirmation sentence (display-ready). */
  message: string;
  data?: unknown;
}

/**
 * Whether a client may safely re-emit the SAME payload after this error.
 * Permanent failures (bad payload, not allowed, not found, already applied) are
 * NOT retryable; transient ones (downstream blip, throttled) are.
 */
const ACK_RETRYABLE: Record<AckErrorCode, boolean> = {
  INVALID_PAYLOAD: false,
  FORBIDDEN: false,
  USER_BANNED: false,
  NOT_FOUND: false,
  CONFLICT: false,
  SERVICE_ERROR: true,
  RATE_LIMITED: true,
};

/** Default localized message key per error code (one sentence per failure). */
const ACK_ERROR_MESSAGE: Record<AckErrorCode, MessageKey> = {
  INVALID_PAYLOAD: "SOCKET_ERR_INVALID_PAYLOAD",
  SERVICE_ERROR: "SOCKET_ERR_SERVICE",
  FORBIDDEN: "SOCKET_ERR_FORBIDDEN",
  USER_BANNED: "USER_BANNED",
  NOT_FOUND: "SOCKET_ERR_NOT_FOUND",
  RATE_LIMITED: "SOCKET_ERR_RATE_LIMITED",
  CONFLICT: "SOCKET_ERR_CONFLICT",
};

export type SocketAck = ((res: unknown) => void) | undefined;

/** Invoke the ack callback if the client supplied one (clients may omit it). */
export function ack(callback: SocketAck, response: unknown): void {
  if (typeof callback === "function") {
    callback(response);
  }
}

/**
 * Success ack with a localized confirmation `message`. Pass a MessageKey + the
 * connection locale; `data` is optional (omit it for fire-and-forget actions
 * like joining a room).
 */
export function ackOk(
  callback: SocketAck,
  messageKey: MessageKey,
  locale: SupportedLocale,
  data?: unknown
): void {
  const message = t(messageKey, ackLocale(locale));
  const response: AckSuccess =
    data === undefined
      ? { success: true, message }
      : { success: true, message, data };
  ack(callback, response);
}

/**
 * Failure ack with the shared error taxonomy + retryable hint + localized message.
 *
 * `detailKey` is an optional, more specific `MessageKey` (e.g. the messageKey off a
 * caught `AppError`, such as "CHAT_MESSAGE_NOT_FOUND") that — when it resolves to
 * real catalog copy — replaces the generic per-code default. This lets callers
 * surface a scenario-specific, actionable message (e.g. "Message not found"
 * instead of "Something went wrong, please try again") without introducing a new
 * response shape: `success`/`error`/`retryable` are unaffected, only `message`.
 * If `detailKey` is omitted, unresolved (not in the catalog — `t()` echoes the key
 * back unchanged), or falsy, the existing generic per-code message is used as-is.
 *
 * `detailKey` is ALSO echoed back on the envelope as `detail` (whether or not it
 * resolved to copy) so clients can branch on the exact reason, not just on the
 * coarse `error` code — see {@link AckError.detail}.
 */
export function ackError(
  callback: SocketAck,
  code: AckErrorCode,
  locale: SupportedLocale,
  detailKey?: string,
  retryAfter?: number
): void {
  const viewerLocale = ackLocale(locale);
  const resolvedDetail = detailKey
    ? t(detailKey as MessageKey, viewerLocale)
    : undefined;
  const message =
    resolvedDetail && resolvedDetail !== detailKey
      ? resolvedDetail
      : t(ACK_ERROR_MESSAGE[code], viewerLocale);
  const err: AckError = {
    success: false,
    error: code,
    retryable: ACK_RETRYABLE[code],
    message,
    ...(detailKey ? { detail: detailKey } : {}),
    ...(retryAfter !== undefined ? { retryAfter } : {}),
  };
  ack(callback, err);
}

const GRPC_STATUS_TO_ACK_CODE: Partial<Record<number, AckErrorCode>> = {
  3: "INVALID_PAYLOAD", // INVALID_ARGUMENT
  5: "NOT_FOUND", // NOT_FOUND
  6: "CONFLICT", // ALREADY_EXISTS
  7: "FORBIDDEN", // PERMISSION_DENIED
  8: "RATE_LIMITED", // RESOURCE_EXHAUSTED
  9: "CONFLICT", // FAILED_PRECONDITION
  16: "FORBIDDEN", // UNAUTHENTICATED
};

/** Matches the UPPER_SNAKE_CASE messageKey convention (e.g. "CHAT_MESSAGE_NOT_FOUND"). */
const MESSAGE_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/**
 * Translate a caught gRPC error into `{ code, detailKey }` for `ackError`.
 *
 * A callee that throws an `AppError` (via `@aimess/errors`) and maps it to a
 * gRPC status (see chat-service's `deleteCommunityMessage`) reaches here as a
 * `grpc.ServiceError`-shaped object whose `details`/`message` is the original
 * `AppError.messageKey` verbatim. Recognized gRPC status codes map to the
 * matching `AckErrorCode`; anything else (network failure, circuit-breaker-open,
 * a raw INTERNAL from the callee, or a non-gRPC error) falls back to
 * `SERVICE_ERROR` with no detail key, which resolves to the existing generic
 * "Something went wrong, please try again" — reserved for truly unexpected
 * failures.
 */
export function resolveGrpcAckError(err: unknown): {
  code: AckErrorCode;
  detailKey?: string;
} {
  const grpcErr = err as
    | { code?: number; details?: string; message?: string }
    | null
    | undefined;
  const mappedCode =
    typeof grpcErr?.code === "number"
      ? GRPC_STATUS_TO_ACK_CODE[grpcErr.code]
      : undefined;
  if (!mappedCode) return { code: "SERVICE_ERROR" };

  const candidate = grpcErr?.details ?? grpcErr?.message;
  const detailKey =
    typeof candidate === "string" && MESSAGE_KEY_PATTERN.test(candidate)
      ? candidate
      : undefined;
  // Surface a ban as its own first-class ack code (not a generic FORBIDDEN):
  // clients branch on `error === "USER_BANNED"` to render the banned state.
  if (detailKey === "USER_BANNED") {
    return { code: "USER_BANNED", detailKey };
  }
  return { code: mappedCode, detailKey };
}
