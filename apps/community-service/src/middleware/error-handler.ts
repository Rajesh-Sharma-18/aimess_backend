import type { NextFunction, Request, Response } from "express";

import { t, type MessageKey } from "@aimess/constants";
import { AppError, ConflictError } from "@aimess/errors";
import { logger } from "@aimess/logger";
import { resolveLocaleFromRequest } from "@aimess/utils";

import { Prisma } from "../generated/prisma/index.js";

/**
 * Stable machine-readable code for the client. The `messageKey` is already an
 * UPPER_SNAKE token for every domain error (`COMMUNITY_INVITE_LINK_EXPIRED`,
 * …); validation errors carry a human sentence instead, which is not a code.
 * Mirrors chat-service's `deriveAppErrorCode`. Emitted ALONGSIDE the localized
 * `message` — the response shape stays backward compatible.
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

export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (error instanceof AppError) {
    res.status(error.statusCode).json({
      success: false,
      code: errorCode(error.messageKey),
      message: localizedMessage(req, error.messageKey, error.message),
    });
    return;
  }

  // Defensive fallback — the service layer normally translates P2002 into the
  // specific COMMUNITY_NAME_TAKEN / COMMUNITY_HANDLE_TAKEN conflict first.
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") {
      const conflict = new ConflictError("COMMUNITY_NAME_TAKEN");
      res.status(conflict.statusCode).json({
        success: false,
        code: errorCode(conflict.messageKey),
        message: localizedMessage(req, conflict.messageKey, conflict.message),
      });
      return;
    }
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
