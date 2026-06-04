import type { Request } from "express";

import { env } from "../config/env.js";

/**
 * Derive the client IP + user-agent for audit/session rows.
 * Honors TRUST_PROXY_HOPS: when proxied, prefer the leftmost X-Forwarded-For
 * entry; otherwise fall back to the direct socket address.
 */
export function getRequestContext(req: Request): {
  ip: string;
  userAgent: string | null;
} {
  let ip = req.socket.remoteAddress ?? "unknown";

  if (env.TRUST_PROXY_HOPS > 0) {
    const forwarded = req.headers["x-forwarded-for"];
    const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const first = raw?.split(",")[0]?.trim();
    if (first) ip = first;
    else if (req.ip) ip = req.ip;
  } else if (req.ip) {
    ip = req.ip;
  }

  const ua = req.headers["user-agent"];
  return { ip, userAgent: typeof ua === "string" ? ua : null };
}
