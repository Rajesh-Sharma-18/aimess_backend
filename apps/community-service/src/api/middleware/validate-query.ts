import type { RequestHandler } from "express";
import type { ZodSchema } from "zod";

/** Validates `req.query` against a Zod schema before controllers run. */
export function validateQuery(schema: ZodSchema): RequestHandler {
  return (req, res, next) => {
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ success: false, errors: parsed.error.flatten() });
      return;
    }
    // Express 5 re-parses req.query on every access, so mutating it in place is
    // lost (coerced/defaulted values never reach the controller). Replace the
    // getter with the validated/coerced result.
    Object.defineProperty(req, "query", {
      value: parsed.data,
      writable: true,
      configurable: true,
      enumerable: true,
    });
    next();
  };
}
