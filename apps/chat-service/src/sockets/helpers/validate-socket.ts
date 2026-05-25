import type { ZodSchema } from "zod";

import { logger } from "@aimess/logger";
import { isAppError } from "@aimess/errors";
import { t, DEFAULT_LOCALE, type MessageKey } from "@aimess/constants";

/** Resolve a thrown error's message: localize catalog keys, else raw message. */
function resolveErrorMessage(error: unknown): string {
  if (isAppError(error)) {
    const appErr = error as import("@aimess/errors").AppError;
    if (appErr.messageKey) {
      const text = t(appErr.messageKey as MessageKey, DEFAULT_LOCALE);
      if (text !== appErr.messageKey) return text;
    }
    return appErr.message;
  }
  return error instanceof Error ? error.message : "Internal error";
}

type SocketCallback = (response: Record<string, unknown>) => void;

/**
 * Validate a socket event payload against a Zod schema.
 * Returns parsed data on success, null on failure (with error sent via callback).
 */
export function validateSocketPayload<T>(
  schema: ZodSchema<T>,
  payload: unknown,
  callback?: SocketCallback
): T | null {
  const result = schema.safeParse(payload);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    const message = firstIssue
      ? `${firstIssue.path.join(".")}: ${firstIssue.message}`
      : "Validation failed";

    logger.debug(`SocketValidation|failed: ${message}`);

    if (typeof callback === "function") {
      callback({
        return_code: "VALIDATION_ERROR",
        message,
      });
    }
    return null;
  }
  return result.data;
}

/**
 * Wrap an async socket handler with error handling.
 * Catches errors and sends formatted error responses via callback.
 */
export async function handleSocketAction(
  fn: () => Promise<void>,
  callback?: SocketCallback
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    const message = resolveErrorMessage(error);
    logger.error(`SocketAction|error: ${message}`);

    if (typeof callback === "function") {
      callback({
        return_code: "ERROR",
        message,
      });
    }
  }
}

/**
 * Format a successful socket response.
 */
export function formatSocketResponse(
  callback: SocketCallback | undefined,
  data: unknown
): void {
  if (typeof callback === "function") {
    callback({
      return_code: "SUCCESS",
      data,
    });
  }
}
