import { resolveLocale, type SupportedLocale } from "@aimess/constants";
import type { Request } from "express";

function headerValue(
  headers: Request["headers"],
  name: string
): string | undefined {
  const value = headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

/** Read locale from `x-lang`, then `Accept-Language`; default `vi`. */
export function resolveLocaleFromRequest(req: Request): SupportedLocale {
  return resolveLocale(
    headerValue(req.headers, "accept-language"),
    headerValue(req.headers, "x-lang")
  );
}
