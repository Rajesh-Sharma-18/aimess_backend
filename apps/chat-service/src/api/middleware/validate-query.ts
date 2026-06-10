import type { NextFunction, Request, Response } from "express";
import type { ZodSchema } from "zod";

import { zodErrorMessage } from "@aimess/utils";

/**
 * Express middleware factory: validate `req.query` against a Zod schema.
 * Express 5 makes `req.query` read-only, so this only validates (responding 400
 * with all issues merged into a single-line message) — controllers continue
 * reading req.query.
 */
export function validateQuery(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      res
        .status(400)
        .json({ success: false, message: zodErrorMessage(result.error) });
      return;
    }
    next();
  };
}
