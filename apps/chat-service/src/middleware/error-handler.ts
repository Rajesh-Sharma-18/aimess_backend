import type { NextFunction, Request, Response } from "express";

import { isAppError } from "@aimess/errors";
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

const STATUS_CODE: Record<number, string> = {
  [HTTP_STATUS.BAD_REQUEST]: "BAD_REQUEST",
  [HTTP_STATUS.UNAUTHORIZED]: "UNAUTHORIZED",
  [HTTP_STATUS.FORBIDDEN]: "FORBIDDEN",
  [HTTP_STATUS.NOT_FOUND]: "NOT_FOUND",
  [HTTP_STATUS.CONFLICT]: "CONFLICT",
  [HTTP_STATUS.UNSUPPORTED_MEDIA_TYPE]: "UNSUPPORTED_MEDIA_TYPE",
  // "RATE_LIMITED", not "TOO_MANY_REQUESTS": this is the code the Socket.IO ack
  // envelope has always used (`AckErrorCode`) and the one the shared HTTP
  // taxonomy uses, so a client can share one branch across both transports.
  [HTTP_STATUS.TOO_MANY_REQUESTS]: "RATE_LIMITED",
};

/**
 * Write the error envelope.
 *
 * chat-service has always nested under `error` (unlike the other eight
 * services, which emit a flat `{ success, message }`). Three fields are added
 * here rather than restructuring: a TOP-LEVEL `message` mirror so this service
 * matches the platform envelope and pre-existing clients reading `data.message`
 * work against it, plus `retryable` and — where known — `retryAfter`, so a
 * client can tell a transient failure from a permanent one without pattern
 * matching on prose. Nothing existing moves.
 */
function respond(
  res: Response,
  status: number,
  code: string,
  message: string,
  retryAfterSec?: number
): void {
  const retryable = status === 408 || status === 429 || status >= 500;

  if (retryAfterSec !== undefined) {
    res.setHeader("Retry-After", String(retryAfterSec));
  }

  res.status(status).json({
    success: false,
    message,
    error: {
      statusCode: status,
      code,
      message,
      ...(retryAfterSec !== undefined ? { retryAfter: retryAfterSec } : {}),
      retryable,
    },
  });
}

/**
 * Stable machine-readable error code. If the messageKey is already a code-like
 * token (UPPER_SNAKE_CASE, e.g. "FRIENDSHIP_REQUIRED") use it; otherwise the
 * messageKey is a human sentence (validation detail) so fall back to a generic
 * status-based code and keep the sentence as the `message`.
 */
function deriveAppErrorCode(appErr: import("@aimess/errors").AppError): string {
  const key = appErr.messageKey;
  if (key && /^[A-Z][A-Z0-9_]*$/.test(key)) return key;
  return STATUS_CODE[appErr.statusCode] ?? "ERROR";
}

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
    respond(
      res,
      appErr.statusCode,
      deriveAppErrorCode(appErr),
      localize(req, appErr.messageKey, appErr.message),
      appErr.retryAfterSec
    );
    return;
  }

  if (isInvalidJsonBodyError(error)) {
    respond(
      res,
      HTTP_STATUS.BAD_REQUEST,
      "INVALID_JSON_BODY",
      localize(req, "CHAT_INVALID_JSON_BODY", "Invalid JSON body")
    );
    return;
  }

  // Prisma errors (e.g. malformed ObjectId, not found, unique conflict)
  const prismaMapped = mapPrismaError(error);
  if (prismaMapped) {
    respond(
      res,
      prismaMapped.status,
      prismaMapped.code,
      localize(req, prismaMapped.key, prismaMapped.key)
    );
    return;
  }

  logger.error("Unhandled chat-service error", {
    service: "chat-service",
    requestId: req.headers["x-request-id"],
    method: req.method,
    path: req.path,
    error,
  });

  respond(
    res,
    HTTP_STATUS.INTERNAL_SERVER_ERROR,
    "INTERNAL_ERROR",
    localize(req, "CHAT_INTERNAL_ERROR", "Internal server error")
  );
}
