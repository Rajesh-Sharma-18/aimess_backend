import type { NextFunction, Request, Response } from "express";

import { AppError } from "@aimess/errors";
import { logger } from "@aimess/logger";
import { getRequestId, sendApiError } from "@aimess/utils";

export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (error instanceof AppError) {
    sendApiError(req, res, {
      statusCode: error.statusCode,
      messageKey: error.messageKey,
      fallbackMessage: error.message,
      retryAfterSec: error.retryAfterSec,
    });
    return;
  }

  // Correlate the stack trace with the id the client was handed, so a user
  // quoting the request id from a 500 can be matched to this line. Previously
  // this was a bare `logger.error(error)` with nothing tying it to a request.
  logger.error("Unhandled gateway error", {
    requestId: getRequestId(req),
    method: req.method,
    path: req.path,
    error,
  });

  sendApiError(req, res, {
    statusCode: 500,
    messageKey: "INTERNAL_SERVER_ERROR",
  });
}
