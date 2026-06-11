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
import { t, type MessageKey, type SupportedLocale } from "@aimess/constants";

// Richer ack error taxonomy so clients can distinguish permanent vs transient
// failures (and whether a blind retry is safe).
export type AckErrorCode =
  | "INVALID_PAYLOAD"
  | "SERVICE_ERROR"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "CONFLICT";

export interface AckError {
  success: false;
  error: AckErrorCode;
  retryable: boolean;
  /** Localized, human-readable explanation for the error (display-ready). */
  message: string;
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
  const message = t(messageKey, locale);
  const response: AckSuccess =
    data === undefined
      ? { success: true, message }
      : { success: true, message, data };
  ack(callback, response);
}

/** Failure ack with the shared error taxonomy + retryable hint + localized message. */
export function ackError(
  callback: SocketAck,
  code: AckErrorCode,
  locale: SupportedLocale
): void {
  const err: AckError = {
    success: false,
    error: code,
    retryable: ACK_RETRYABLE[code],
    message: t(ACK_ERROR_MESSAGE[code], locale),
  };
  ack(callback, err);
}
