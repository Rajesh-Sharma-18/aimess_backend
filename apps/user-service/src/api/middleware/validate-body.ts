import { t } from "@aimess/constants";
import { zodErrorMessage, zodFieldErrors } from "@aimess/utils";
import type { RequestHandler } from "express";
import type { ZodSchema } from "zod";

export function validateBody(schema: ZodSchema): RequestHandler {
  return (req, res, next) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      // `code` + `errors` are additive: clients that only read `message` are
      // unaffected, but a form can now mark the field that actually failed
      // instead of showing one comma-joined sentence.
      res.status(400).json({
        success: false,
        code: "VALIDATION_FAILED",
        message:
          zodErrorMessage(parsed.error) || t("VALIDATION_FAILED", req.locale),
        errors: zodFieldErrors(parsed.error),
      });
      return;
    }
    req.body = parsed.data;
    next();
  };
}
