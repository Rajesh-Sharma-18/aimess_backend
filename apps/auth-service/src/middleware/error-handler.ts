import type { NextFunction, Request, Response } from "express";

import { HTTP_STATUS, t, type MessageKey } from "@aimess/constants";
import { ConflictError, isAppError } from "@aimess/errors";
import { logger } from "@aimess/logger";
import { resolveLocaleFromRequest } from "@aimess/utils";

import { Prisma } from "../generated/prisma/client.js";

function isInvalidJsonBodyError(error: unknown): boolean {
  if (!(error instanceof SyntaxError)) return false;

  const bodyError = error as SyntaxError & {
    status?: number;
    statusCode?: number;
    type?: string;
  };

  return (
    bodyError.type === "entity.parse.failed" ||
    bodyError.status === 400 ||
    bodyError.statusCode === 400
  );
}

function localizedMessage(
  req: Request,
  messageKey: string | undefined,
  fallback: string
): string {
  if (!messageKey) return fallback;

  const locale = req.locale ?? resolveLocaleFromRequest(req);
  try {
    const message = t(messageKey as MessageKey, locale);
    return message === messageKey ? fallback : message;
  } catch {
    return fallback;
  }
}

export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (isAppError(error)) {
    res.status(error.statusCode).json({
      success: false,
      message: localizedMessage(req, error.messageKey, error.message),
    });
    return;
  }

  const locale = req.locale ?? resolveLocaleFromRequest(req);

  if (isInvalidJsonBodyError(error)) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      message: t("VALIDATION_FAILED", locale),
    });
    return;
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") {
      const conflict = new ConflictError("AUTH_EMAIL_EXISTS");
      res.status(conflict.statusCode).json({
        success: false,
        message: localizedMessage(req, conflict.messageKey, conflict.message),
      });
      return;
    }
  }

  logger.error(error);

  if (error instanceof Error) {
    res.status(500).json({
      success: false,
      message: t("INTERNAL_SERVER_ERROR", locale),
    });
    return;
  }

  res.status(500).json({
    success: false,
    message: t("INTERNAL_SERVER_ERROR", locale),
  });
}
