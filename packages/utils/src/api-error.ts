import { t, type MessageKey, type SupportedLocale } from "@aimess/constants";
import {
  isAppError,
  isRetryableStatus,
  resolveErrorCode,
  type ApiErrorCode,
} from "@aimess/errors";

/**
 * A code-like token is an UPPER_SNAKE_CASE identifier. Every domain
 * `messageKey` is one (`AUTH_EMAIL_EXISTS`, `COMMUNITY_JOIN_BANNED`, …);
 * a validation detail is a human sentence and must never be echoed as a code.
 */
const CODE_LIKE = /^[A-Z][A-Z0-9_]*$/;

/**
 * The stable, machine-readable classification a client branches on.
 *
 * Prefers the DOMAIN key (`AUTH_EMAIL_EXISTS`) when the error carries one,
 * falling back to the TRANSPORT class derived from the status
 * (`BAD_REQUEST`, `RATE_LIMITED`, …). Seven of the nine services already
 * derived it this way — this is that rule, in one place.
 */
export function resolveApiErrorCode(
  statusCode: number,
  messageKey?: string
): string {
  if (messageKey && CODE_LIKE.test(messageKey)) return messageKey;
  return resolveErrorCode(statusCode);
}

/** Field-level validation failures, keyed by dotted path. */
export type ApiErrorDetails = Record<string, string[]>;

/**
 * The structured error envelope every HTTP surface answers with.
 *
 * ## Why fields are duplicated
 *
 * This shape is the strict SUPERSET of the nine hand-rolled envelopes that
 * preceded it, so adopting it breaks nothing:
 *
 * - top-level `message` — read by the web app's `getApiErrorMessage`, the iOS
 *   and Android clients, and ~344 backend tests. Every service emitted it.
 * - top-level `code` — auth, user, backoffice, community and media emitted it.
 * - `error.statusCode` — chat-service emitted it.
 * - `error.{code,message,retryAfter,retryable,requestId}` — the api-gateway and
 *   chat-service envelope.
 *
 * `details` is the only genuinely new field (previously `errors`, and only in
 * user-service). New clients should read `error.*`; the top-level `message` and
 * `code` are duplicated mirrors, not authoritative, and can be dropped once
 * every client has migrated.
 */
export interface ApiErrorBody {
  success: false;
  /** @deprecated Read `error.message`. Retained for pre-existing clients. */
  message: string;
  /** @deprecated Read `error.code`. Retained for pre-existing clients. */
  code: string;
  error: {
    /** Echo of the HTTP status, for clients that only see the parsed body. */
    statusCode: number;
    /** Stable, machine-readable classification — domain key or transport class. */
    code: string;
    /** Localized, display-ready sentence. Same string as the top-level `message`. */
    message: string;
    /** Field-level validation failures. Only present on 400/422. */
    details?: ApiErrorDetails;
    /** Seconds to wait before retrying. Present on 429/503 when known. */
    retryAfter?: number;
    /** Whether re-sending this exact request could succeed later. */
    retryable: boolean;
    /**
     * Correlation id for this request, echoed so a user can quote it in a bug
     * report and support can find the matching log line. Set by the API layer
     * from `x-request-id`.
     */
    requestId?: string;
  };
}

/** Resolve `messageKey` through the shared catalog, falling back to `fallback`. */
function localize(
  messageKey: string | undefined,
  locale: SupportedLocale,
  fallback: string
): string {
  if (!messageKey) return fallback;
  const resolved = t(messageKey as MessageKey, locale);
  // `t()` echoes an unknown key back verbatim. Showing a user the literal
  // string "RATE_LIMITED" is what this guard exists to prevent.
  return resolved === messageKey ? fallback : resolved;
}

export interface BuildApiErrorOptions {
  statusCode: number;
  locale: SupportedLocale;
  /** Catalog key; falls back to `fallbackMessage` when absent or unknown. */
  messageKey?: string;
  /** Used when `messageKey` resolves to nothing. */
  fallbackMessage?: string;
  retryAfterSec?: number;
  requestId?: string;
  /** Field-level validation failures. */
  details?: ApiErrorDetails;
  /** Override the derived code (rarely needed). */
  code?: ApiErrorCode | (string & {});
}

/** Build the wire body for a failed request. Pure — does not touch the response. */
export function buildApiError({
  statusCode,
  locale,
  messageKey,
  fallbackMessage,
  retryAfterSec,
  requestId,
  details,
  code,
}: BuildApiErrorOptions): ApiErrorBody {
  const resolvedCode = code ?? resolveApiErrorCode(statusCode, messageKey);
  const message = localize(
    messageKey,
    locale,
    fallbackMessage ?? t("INTERNAL_SERVER_ERROR", locale)
  );

  return {
    success: false,
    message,
    code: resolvedCode,
    error: {
      statusCode,
      code: resolvedCode,
      message,
      ...(details && Object.keys(details).length > 0 ? { details } : {}),
      ...(retryAfterSec !== undefined && retryAfterSec >= 0
        ? { retryAfter: retryAfterSec }
        : {}),
      retryable: isRetryableStatus(statusCode),
      ...(requestId ? { requestId } : {}),
    },
  };
}

/** Narrow an unknown throwable into the fields `buildApiError` needs. */
export function describeError(error: unknown): {
  statusCode: number;
  messageKey?: string;
  retryAfterSec?: number;
} {
  if (isAppError(error)) {
    const appError = error as {
      statusCode: number;
      messageKey?: string;
      retryAfterSec?: number;
    };
    return {
      statusCode: appError.statusCode,
      messageKey: appError.messageKey,
      retryAfterSec: appError.retryAfterSec,
    };
  }
  return { statusCode: 500 };
}
