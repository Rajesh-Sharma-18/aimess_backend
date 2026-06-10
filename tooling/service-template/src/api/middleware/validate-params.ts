import type { RequestHandler } from "express";
import type { ZodSchema } from "zod";

/** Validates `req.params` against a Zod schema before controllers run.
 *  On failure, responds 400 with all issues merged into a single-line message. */
export function validateParams(schema: ZodSchema): RequestHandler {
  return (req, res, next) => {
    const parsed = schema.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        message: parsed.error.issues.map((i) => i.message).join(", "),
      });
      return;
    }
    Object.assign(req.params, parsed.data);
    next();
  };
}
