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
    // Express 5 leaves `req.body` undefined when the request carries no body at
    // all (Express 4 defaulted it to `{}`). Endpoints whose schema is entirely
    // optional — `/:roomId/leave` — must still accept a body-less POST, so
    // normalize here instead of teaching every such schema to accept undefined.
    // Schemas with required fields still reject `{}` with the same 400.
    const result = schema.safeParse(req.body ?? {});
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
