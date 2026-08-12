import type { NextFunction, Request, Response } from "express";

import { t, type MessageKey } from "@aimess/constants";
import { AppError, deriveAppErrorCode } from "@aimess/errors";
import { logger } from "@aimess/logger";
import { resolveLocaleFromRequest } from "@aimess/utils";

function localizedMessage(
  req: Request,
  messageKey: string | undefined,
  fallback: string
): string {
  if (!messageKey) return fallback;
  const locale = req.locale ?? resolveLocaleFromRequest(req);
  return t(messageKey as MessageKey, locale);
}

export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (error instanceof AppError) {
    res.status(error.statusCode).json({
      success: false,
      // `message` is localized, so it can never be branched on — `code` is the stable token clients compare against.
      code: deriveAppErrorCode(error),
      message: localizedMessage(req, error.messageKey, error.message),
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
    message: t("INTERNAL_SERVER_ERROR", locale),
  });
}
