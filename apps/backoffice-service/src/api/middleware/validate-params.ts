import { t } from "@aimess/constants";
import type { RequestHandler } from "express";
import type { ZodSchema } from "zod";

/** Validates `req.params` against a Zod schema before controllers run. */
export function validateParams(schema: ZodSchema): RequestHandler {
  return (req, res, next) => {
    const parsed = schema.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        message: t("VALIDATION_FAILED", req.locale),
        errors: parsed.error.flatten(),
      });
      return;
    }
    Object.assign(req.params, parsed.data);
    next();
  };
}
