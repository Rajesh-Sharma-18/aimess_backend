import type { NextFunction, Request, Response } from "express";
import type { ZodSchema } from "zod";

import { BadRequestError } from "@aimess/errors";

/**
 * Express middleware factory: validate request body against a Zod schema.
 * On success, replaces `req.body` with the parsed (and coerced) value.
 * On failure, throws BadRequestError with the first error message.
 */
export function validateBody(schema: ZodSchema) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const firstIssue = result.error.issues[0];
      const message = firstIssue
        ? `${firstIssue.path.join(".")}: ${firstIssue.message}`
        : "Validation failed";
      throw new BadRequestError(message);
    }
    req.body = result.data;
    next();
  };
}
