import type { RequestHandler } from "express";
import {
  resolveTimeZone,
  runWithLocale,
  runWithTimeZone,
} from "@aimess/constants";

import { resolveLocaleFromRequest } from "./resolve-locale.js";

declare global {
  namespace Express {
    interface Request {
      locale: import("@aimess/constants").SupportedLocale;
      /** Viewer IANA zone from `x-timezone`; "UTC" when missing/invalid. */
      timeZone: string;
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
  req.timeZone = resolveTimeZone(req.header("x-timezone"));
  runWithLocale(req.locale, () => runWithTimeZone(req.timeZone, next));
};
