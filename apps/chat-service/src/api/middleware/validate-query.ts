import type { NextFunction, Request, Response } from "express";
import type { ZodSchema } from "zod";

import { BadRequestError } from "@aimess/errors";

/**
 * Express middleware factory: validate `req.query` against a Zod schema.
 * Express 5 makes `req.query` read-only, so this only validates (rejecting bad
 * input with a field-level message) — controllers continue reading req.query.
 */
export function validateQuery(schema: ZodSchema) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      const firstIssue = result.error.issues[0];
      const message = firstIssue
        ? `${firstIssue.path.join(".")}: ${firstIssue.message}`
        : "Invalid query parameters";
      throw new BadRequestError(message);
    }
    next();
  };
}
