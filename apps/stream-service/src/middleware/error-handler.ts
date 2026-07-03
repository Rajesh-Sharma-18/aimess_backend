import type { NextFunction, Request, Response } from "express";

import { t, type MessageKey } from "@aimess/constants";
import { AppError } from "@aimess/errors";
import { logger } from "@aimess/logger";
import { resolveLocaleFromRequest } from "@aimess/utils";

function appErrorCode(error: AppError): string | undefined {
  const key = error.messageKey;
  if (key && /^[A-Z][A-Z0-9_]*$/.test(key)) return key;
  return undefined;
}

export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  const locale = req.locale ?? resolveLocaleFromRequest(req);

  if (error instanceof AppError) {
    const code = appErrorCode(error);
    res.status(error.statusCode).json({
      success: false,
      message: error.messageKey
        ? t(error.messageKey as MessageKey, locale)
        : error.message,
      ...(code ? { detail: { code } } : {}),
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

  res.status(500).json({
    success: false,
    message: t("INTERNAL_SERVER_ERROR", locale),
  });
}
