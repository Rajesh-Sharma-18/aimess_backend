import type { RequestHandler } from "express";

import { resolveLocaleFromRequest } from "./resolve-locale.js";

declare global {
  namespace Express {
    interface Request {
      locale: import("@aimess/constants").SupportedLocale;
    }
  }
}

/** Attach `req.locale` for controllers and error handlers. */
export const localeMiddleware: RequestHandler = (req, _res, next) => {
  req.locale = resolveLocaleFromRequest(req);
  next();
};
