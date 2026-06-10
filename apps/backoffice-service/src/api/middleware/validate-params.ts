import { t } from "@aimess/constants";
import { zodErrorMessage } from "@aimess/utils";
import type { RequestHandler } from "express";
import type { ZodSchema } from "zod";

/** Validates `req.params` against a Zod schema before controllers run. */
export function validateParams(schema: ZodSchema): RequestHandler {
  return (req, res, next) => {
    const parsed = schema.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        message:
          zodErrorMessage(parsed.error) || t("VALIDATION_FAILED", req.locale),
      });
      return;
    }
    Object.assign(req.params, parsed.data);
    next();
  };
}
