import { t } from "@aimess/constants";
import type { RequestHandler } from "express";
import type { ZodSchema } from "zod";

export function validateBody(schema: ZodSchema): RequestHandler {
  return (req, res, next) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        message: t("VALIDATION_FAILED", req.locale),
        errors: parsed.error.flatten(),
      });
      return;
    }
    req.body = parsed.data;
    next();
  };
}
