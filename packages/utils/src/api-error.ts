import { t, type MessageKey, type SupportedLocale } from "@aimess/constants";
import {
  isAppError,
  isRetryableStatus,
  resolveErrorCode,
  type ApiErrorCode,
} from "@aimess/errors";

/**
 * The structured error envelope every HTTP surface answers with.
 *
 * ## Why `message` appears twice
 *
 * The documented shape is `{ success: false, error: { code, message, retryAfter,
 * retryable } }`. Every existing client — the web app's `getApiErrorMessage`,
 * the iOS and Android clients, and ~344 backend tests — reads the TOP-LEVEL
 * `message` that nine hand-rolled error handlers have emitted since day one.
 * Removing it in the same change that introduces `error` would break all of
 * them at once for no functional gain.
 *
 * So this is a strictly ADDITIVE migration: the top-level `message` is retained
 * verbatim, and `error` is added beside it. New clients read `error.code` /
 * `error.retryAfter` / `error.retryable`; old clients keep working untouched.
 *
 * Drop the top-level `message` only once every client reads `error.message` —
 * it is duplicated, not authoritative.
 */
export interface ApiErrorBody {
  success: false;
  /** @deprecated Read `error.message`. Retained for pre-existing clients. */
  message: string;
  error: {
    /** Stable, machine-readable transport classification. */
    code: ApiErrorCode;
    /** Localized, display-ready sentence. Same string as the top-level `message`. */
    message: string;
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
  /** Override the status-derived code (rarely needed). */
  code?: ApiErrorCode;
}

/** Build the wire body for a failed request. Pure — does not touch the response. */
export function buildApiError({
  statusCode,
  locale,
  messageKey,
  fallbackMessage,
  retryAfterSec,
  requestId,
  code,
}: BuildApiErrorOptions): ApiErrorBody {
  const resolvedCode = code ?? resolveErrorCode(statusCode);
  const message = localize(
    messageKey,
    locale,
    fallbackMessage ?? t("INTERNAL_SERVER_ERROR", locale)
  );

  return {
    success: false,
    message,
    error: {
      code: resolvedCode,
      message,
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
