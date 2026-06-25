import type { NextFunction, Request, Response } from "express";

import { t, type MessageKey } from "@aimess/constants";
import { AppError } from "@aimess/errors";
import { logger } from "@aimess/logger";
import { resolveLocaleFromRequest } from "@aimess/utils";

export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  const locale = req.locale ?? resolveLocaleFromRequest(req);

  if (error instanceof AppError) {
    res.status(error.statusCode).json({
      success: false,
      message: error.messageKey
        ? t(error.messageKey as MessageKey, locale)
        : error.message,
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
