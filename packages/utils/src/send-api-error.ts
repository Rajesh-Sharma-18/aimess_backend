import type { Request, Response } from "express";

import {
  buildApiError,
  describeError,
  type BuildApiErrorOptions,
} from "./api-error.js";
import { resolveLocaleFromRequest } from "./resolve-locale.js";

/** Correlation id for this request, if the API layer set one. */
export function getRequestId(req: Request): string | undefined {
  const value = req.headers["x-request-id"];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Write a structured error response.
 *
 * Also emits the `Retry-After` header whenever `retryAfterSec` is known. That
 * header is the whole point of the exercise: without it a rate-limited client
 * has nothing to wait on and falls back to guessing, which is what turns one
 * 429 into a retry storm. `express-rate-limit` sets it for the limiters it
 * owns; every hand-rolled limiter and every 503 has to set it here.
 */
export function sendApiError(
  req: Request,
  res: Response,
  options: Omit<BuildApiErrorOptions, "locale" | "requestId"> & {
    locale?: BuildApiErrorOptions["locale"];
  }
): void {
  if (res.headersSent) return;

  const locale = options.locale ?? req.locale ?? resolveLocaleFromRequest(req);
  const body = buildApiError({
    ...options,
    locale,
    requestId: getRequestId(req),
  });

  if (body.error.retryAfter !== undefined) {
    res.setHeader("Retry-After", String(body.error.retryAfter));
  }

  res.status(options.statusCode).json(body);
}

/** Write a structured error response derived from a thrown value. */
export function sendCaughtApiError(
  req: Request,
  res: Response,
  error: unknown,
  fallbackMessage?: string
): void {
  const described = describeError(error);
  sendApiError(req, res, { ...described, fallbackMessage });
}

/**
 * `express-rate-limit` `handler` that answers in the shared envelope.
 *
 * The limiters that used the library's `message` option instead answered with a
 * hand-written `{ success, message }` — English-only, no `code`, and no
 * `retryAfter` in the body, so a throttled client had nothing to branch on and
 * nothing to wait on. `resetTime` is the library's own view of when the window
 * clears, which is why the hint is derived from it rather than guessed.
 */
export function rateLimitHandler(messageKey = "RATE_LIMITED") {
  return (req: Request, res: Response): void => {
    const info = (req as Request & { rateLimit?: { resetTime?: Date } })
      .rateLimit;
    const retryAfterSec =
      info?.resetTime instanceof Date
        ? Math.max(0, Math.ceil((info.resetTime.getTime() - Date.now()) / 1000))
        : undefined;

    sendApiError(req, res, { statusCode: 429, messageKey, retryAfterSec });
  };
}
