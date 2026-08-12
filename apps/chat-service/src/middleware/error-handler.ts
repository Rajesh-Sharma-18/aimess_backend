import type { NextFunction, Request, Response } from "express";

import { deriveAppErrorCode, isAppError } from "@aimess/errors";
import { logger } from "@aimess/logger";
import { HTTP_STATUS, t, type MessageKey } from "@aimess/constants";
import { resolveLocaleFromRequest } from "@aimess/utils";

/**
 * Localize a message: if `key` is a catalog key, resolve it for the request
 * locale; otherwise return the raw fallback text.
 */
function localize(
  req: Request,
  key: string | undefined,
  fallback: string
): string {
  if (!key) return fallback;
  const locale = req.locale ?? resolveLocaleFromRequest(req);
  const text = t(key as MessageKey, locale);
  // `t` returns the key unchanged when it's not in the catalog → use fallback.
  return text === key ? fallback : text;
}

function isInvalidJsonBodyError(error: unknown): boolean {
  if (!(error instanceof SyntaxError)) return false;
  const bodyError = error as SyntaxError & {
    status?: number;
    statusCode?: number;
    type?: string;
  };
  return (
    bodyError.type === "entity.parse.failed" ||
    bodyError.status === HTTP_STATUS.BAD_REQUEST ||
    bodyError.statusCode === HTTP_STATUS.BAD_REQUEST
  );
}

type ErrorResponse = { status: number; code: string; key: MessageKey };

/**
 * Map a Prisma error to a clean HTTP response. Detected by error name/code so
 * we don't import classes from the generated client. Never leaks Prisma's
 * verbose internal message to the client.
 */
function mapPrismaError(error: unknown): ErrorResponse | null {
  if (!(error instanceof Error)) return null;

  if (error.name === "PrismaClientKnownRequestError") {
    const code = (error as Error & { code?: string }).code;
    switch (code) {
      case "P2023": // malformed ObjectID / inconsistent column data
        return {
          status: HTTP_STATUS.BAD_REQUEST,
          code: "INVALID_ID_FORMAT",
          key: "CHAT_INVALID_ID_FORMAT",
        };
      case "P2025": // record required but not found
        return {
          status: HTTP_STATUS.NOT_FOUND,
          code: "NOT_FOUND",
          key: "CHAT_NOT_FOUND",
        };
      case "P2002": // unique constraint violated
        return {
          status: HTTP_STATUS.CONFLICT,
          code: "CONFLICT",
          key: "CHAT_RESOURCE_CONFLICT",
        };
      case "P2003": // foreign key / referenced record missing
        return {
          status: HTTP_STATUS.BAD_REQUEST,
          code: "INVALID_REFERENCE",
          key: "CHAT_INVALID_REFERENCE",
        };
      default:
        return {
          status: HTTP_STATUS.BAD_REQUEST,
          code: "DATABASE_REQUEST_ERROR",
          key: "CHAT_REQUEST_FAILED",
        };
    }
  }

  if (error.name === "PrismaClientValidationError") {
    // invalid query args (e.g. wrong type / unknown field)
    return {
      status: HTTP_STATUS.BAD_REQUEST,
      code: "INVALID_REQUEST",
      key: "CHAT_INVALID_REQUEST",
    };
  }

  return null;
}

export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (isAppError(error)) {
    const appErr = error as import("@aimess/errors").AppError;
    res.status(appErr.statusCode).json({
      success: false,
      error: {
        statusCode: appErr.statusCode,
        code: deriveAppErrorCode(appErr),
        message: localize(req, appErr.messageKey, appErr.message),
      },
    });
    return;
  }

  if (isInvalidJsonBodyError(error)) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      error: {
        statusCode: HTTP_STATUS.BAD_REQUEST,
        code: "INVALID_JSON_BODY",
        message: localize(req, "CHAT_INVALID_JSON_BODY", "Invalid JSON body"),
      },
    });
    return;
  }

  // Prisma errors (e.g. malformed ObjectId, not found, unique conflict)
  const prismaMapped = mapPrismaError(error);
  if (prismaMapped) {
    res.status(prismaMapped.status).json({
      success: false,
      error: {
        statusCode: prismaMapped.status,
        code: prismaMapped.code,
        message: localize(req, prismaMapped.key, prismaMapped.key),
      },
    });
    return;
  }

  logger.error(error);

  res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
    success: false,
    error: {
      statusCode: HTTP_STATUS.INTERNAL_SERVER_ERROR,
      code: "INTERNAL_ERROR",
      message: localize(req, "CHAT_INTERNAL_ERROR", "Internal server error"),
    },
  });
}
