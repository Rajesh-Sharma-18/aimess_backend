import { t } from "@aimess/constants";
import { zodErrorMessage } from "@aimess/utils";
import type { RequestHandler } from "express";
import type { ZodSchema } from "zod";

export function validateBody(schema: ZodSchema): RequestHandler {
  return (req, res, next) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        message:
          zodErrorMessage(parsed.error) || t("VALIDATION_FAILED", req.locale),
      });
      return;
    }
    req.body = parsed.data;
    next();
  };
}
