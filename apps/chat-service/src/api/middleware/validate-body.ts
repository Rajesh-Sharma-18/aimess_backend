import type { NextFunction, Request, Response } from "express";
import type { ZodSchema } from "zod";

import { zodErrorMessage } from "@aimess/utils";

/**
 * Express middleware factory: validate request body against a Zod schema.
 * On success, replaces `req.body` with the parsed (and coerced) value.
 * On failure, responds 400 with all issues merged into a single-line message.
 */
export function validateBody(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      res
        .status(400)
        .json({ success: false, message: zodErrorMessage(result.error) });
      return;
    }
    req.body = result.data;
    next();
  };
}
