import type { NextFunction, Request, Response } from "express";

import { logger } from "@aimess/logger";
import { isAppError } from "@aimess/errors";

import { sendApiError } from "./send-api-error.js";
import type { ApiErrorDetails } from "./api-error.js";

/**
 * Winston serializes a bare `Error` to `{}` — `message` and `stack` are
 * non-enumerable — so logging the throwable directly produced `error: {}` and
 * threw away the only useful part. Flattened here instead.
 */
function describeForLog(error: unknown): unknown {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      ...("code" in error ? { code: (error as { code?: unknown }).code } : {}),
    };
  }
  return error;
}

/**
 * The one Express error handler every service mounts.
 *
 * Nine services previously hand-rolled this, and drifted into six different
 * response shapes: `{success, message}`, `{success, code, message}`,
 * `{success, message, detail:{code}}`, a nested `error` object with
 * `statusCode`, one without it, and notifications-service — which echoed the
 * raw `Error.message` of an unhandled crash straight to the client. Every one
 * of them now goes through `sendApiError`, so the envelope is defined once.
 *
 * Service-specific behaviour is passed in rather than forked:
 * `uniqueConstraintKey` names the domain conflict a Prisma P2002 means here
 * (`AUTH_EMAIL_EXISTS` vs `USER_USERNAME_TAKEN` vs `COMMUNITY_NAME_TAKEN`),
 * and `mapError` handles anything genuinely local before the shared branches.
 */
export interface ErrorHandlerOptions {
  /** Service name, used to tag the log line for an unhandled error. */
  service: string;
  /**
   * Domain messageKey for a unique-constraint violation (Prisma P2002).
   * Receives the constraint target so a service with more than one unique
   * column can tell them apart. Omit to fall back to a generic conflict.
   */
  uniqueConstraintKey?: (target: string) => string;
  /**
   * Service-local mapping, tried BEFORE the shared branches. Return `null` to
   * fall through.
   */
  mapError?: (
    error: unknown,
    req: Request
  ) => {
    statusCode: number;
    messageKey?: string;
    fallbackMessage?: string;
    details?: ApiErrorDetails;
  } | null;
}

/** `express.json()` rejects a malformed body with a tagged SyntaxError. */
function isInvalidJsonBody(error: unknown): boolean {
  if (!(error instanceof SyntaxError)) return false;
  const parseError = error as SyntaxError & {
    status?: number;
    statusCode?: number;
    type?: string;
  };
  return (
    parseError.type === "entity.parse.failed" ||
    parseError.status === 400 ||
    parseError.statusCode === 400
  );
}

/** `express.json({ limit })` rejects an oversized body with status 413. */
function isPayloadTooLarge(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const bodyError = error as Error & {
    status?: number;
    statusCode?: number;
    type?: string;
  };
  return (
    bodyError.type === "entity.too.large" ||
    bodyError.status === 413 ||
    bodyError.statusCode === 413
  );
}

/**
 * Map a Prisma failure onto a clean status + domain key.
 *
 * Detected by `error.name`, never by importing the generated client — each
 * service generates its own, and this package must not depend on any of them.
 * Prisma's own message is verbose and leaks schema internals, so it is logged
 * and never forwarded.
 */
function mapPrismaError(
  error: unknown,
  uniqueConstraintKey?: (target: string) => string
): { statusCode: number; messageKey: string } | null {
  if (!(error instanceof Error)) return null;

  if (error.name === "PrismaClientValidationError") {
    return { statusCode: 400, messageKey: "VALIDATION_FAILED" };
  }

  if (error.name !== "PrismaClientKnownRequestError") return null;

  const prismaError = error as Error & {
    code?: string;
    meta?: { target?: unknown };
  };

  switch (prismaError.code) {
    case "P2002": {
      const target = String(prismaError.meta?.target ?? "");
      return {
        statusCode: 409,
        messageKey: uniqueConstraintKey?.(target) ?? "RESOURCE_CONFLICT",
      };
    }
    case "P2023": // malformed ObjectId / inconsistent column data
      return { statusCode: 400, messageKey: "INVALID_ID_FORMAT" };
    case "P2025": // record required but not found
      return { statusCode: 404, messageKey: "RESOURCE_NOT_FOUND" };
    case "P2003": // foreign key / referenced record missing
      return { statusCode: 400, messageKey: "INVALID_REFERENCE" };
    default:
      return { statusCode: 400, messageKey: "REQUEST_FAILED" };
  }
}

export function createErrorHandler({
  service,
  uniqueConstraintKey,
  mapError,
}: ErrorHandlerOptions) {
  return function errorHandler(
    error: unknown,
    req: Request,
    res: Response,
    _next: NextFunction
  ): void {
    const local = mapError?.(error, req);
    if (local) {
      sendApiError(req, res, local);
      return;
    }

    if (isAppError(error)) {
      const appError = error as {
        statusCode: number;
        message: string;
        messageKey?: string;
        retryAfterSec?: number;
      };
      sendApiError(req, res, {
        statusCode: appError.statusCode,
        messageKey: appError.messageKey,
        fallbackMessage: appError.message,
        retryAfterSec: appError.retryAfterSec,
      });
      return;
    }

    if (isPayloadTooLarge(error)) {
      sendApiError(req, res, {
        statusCode: 413,
        messageKey: "PAYLOAD_TOO_LARGE",
      });
      return;
    }

    if (isInvalidJsonBody(error)) {
      sendApiError(req, res, {
        statusCode: 400,
        messageKey: "INVALID_JSON_BODY",
      });
      return;
    }

    const prismaMapped = mapPrismaError(error, uniqueConstraintKey);
    if (prismaMapped) {
      // Logged at warn, not error: these are caused by the request, not a fault.
      logger.warn("Prisma request error", {
        service,
        requestId: req.headers["x-request-id"],
        method: req.method,
        path: req.path,
        error: describeForLog(error),
      });
      sendApiError(req, res, prismaMapped);
      return;
    }

    // Correlate the stack with the id the client was handed, so a user quoting
    // the request id from a 500 can be matched to this line.
    logger.error("Unhandled error", {
      service,
      requestId: req.headers["x-request-id"],
      method: req.method,
      path: req.path,
      error: describeForLog(error),
    });

    // Never the caught error's own message: an unhandled throw can carry a
    // connection string, a query, or a stack frame.
    sendApiError(req, res, {
      statusCode: 500,
      messageKey: "INTERNAL_SERVER_ERROR",
    });
  };
}

/** Terminates the middleware chain so an unmatched path answers JSON, not HTML. */
export function notFoundHandler(req: Request, res: Response): void {
  sendApiError(req, res, { statusCode: 404, messageKey: "ROUTE_NOT_FOUND" });
}
