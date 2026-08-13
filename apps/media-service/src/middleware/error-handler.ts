import type { NextFunction, Request, Response } from "express";

import { t, type MessageKey } from "@aimess/constants";
import { AppError } from "@aimess/errors";
import { logger } from "@aimess/logger";
import { resolveLocaleFromRequest } from "@aimess/utils";

/**
 * Stable machine-readable code for the client. Mirrors community-service's
 * `errorCode` / chat-service's `deriveAppErrorCode`: the `messageKey` is already
 * an UPPER_SNAKE token for every domain error, while a raw validation sentence
 * is not a code and must not be echoed as one.
 */
function errorCode(messageKey: string | undefined): string | undefined {
  return messageKey && /^[A-Z][A-Z0-9_]*$/.test(messageKey)
    ? messageKey
    : undefined;
}

function localizedMessage(
  req: Request,
  messageKey: string | undefined,
  fallback: string
): string {
  if (!messageKey) return fallback;
  const locale = req.locale ?? resolveLocaleFromRequest(req);
  return t(messageKey as MessageKey, locale);
}

/**
 * Express body-parser errors (`express.json({ limit })`) are not `AppError`s but
 * DO carry an HTTP status. Without this they fell through to the generic branch
 * and a client that sent a >1 MB body — or malformed JSON — was told the server
 * had crashed.
 */
function statusOfBodyParserError(
  error: unknown
): { status: number; code: string } | null {
  if (!(error instanceof Error)) return null;
  const status =
    (error as { status?: number; statusCode?: number }).status ??
    (error as { statusCode?: number }).statusCode;
  const type = (error as { type?: string }).type;
  if (status === 413 || type === "entity.too.large") {
    return { status: 413, code: "UPLOAD_FILE_TOO_LARGE" };
  }
  if (error instanceof SyntaxError && status === 400) {
    return { status: 400, code: "MEDIA_REQUEST_INVALID" };
  }
  return null;
}

export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (error instanceof AppError) {
    // `code` is the STABLE, locale-independent discriminator. `message` is
    // localized, so a client that switch-ed on the text broke as soon as the
    // user's locale changed — and the published OpenAPI examples already showed
    // an `error.code` field that the runtime never actually sent.
    //
    // The code names the CLASS of failure only. It never carries the detector
    // detail (signature name, threshold, offset, bucket, path); that goes to the
    // audit log. See docs/MEDIA_SECURITY_AUDIT.md §Error Handling.
    res.status(error.statusCode).json({
      success: false,
      code: errorCode(error.messageKey),
      message: localizedMessage(req, error.messageKey, error.message),
    });
    return;
  }

  const bodyParserError = statusOfBodyParserError(error);
  if (bodyParserError) {
    res.status(bodyParserError.status).json({
      success: false,
      code: bodyParserError.code,
      message: localizedMessage(req, bodyParserError.code, "Request rejected"),
    });
    return;
  }

  if (error instanceof Error) {
    logger.error(error.message);
    if (error.stack) {
      logger.error(error.stack);
    }
  } else {
    logger.error(error);
  }

  const locale = req.locale ?? resolveLocaleFromRequest(req);

  res.status(500).json({
    success: false,
    code: "INTERNAL_SERVER_ERROR",
    message: t("INTERNAL_SERVER_ERROR", locale),
  });
}
