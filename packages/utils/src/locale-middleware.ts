import type { RequestHandler } from "express";
import { runWithLocale } from "@aimess/constants";

import { resolveLocaleFromRequest } from "./resolve-locale.js";

declare global {
  namespace Express {
    interface Request {
      locale: import("@aimess/constants").SupportedLocale;
    }
  }
}

/**
 * Attach `req.locale` for controllers and error handlers, and publish it on the
 * ambient locale context so serializers deep in a service (and any gRPC call
 * this request makes) resolve the same language without being handed it
 * explicitly. See `@aimess/constants` `locale-context.ts`.
 */
export const localeMiddleware: RequestHandler = (req, _res, next) => {
  req.locale = resolveLocaleFromRequest(req);
  runWithLocale(req.locale, next);
};
