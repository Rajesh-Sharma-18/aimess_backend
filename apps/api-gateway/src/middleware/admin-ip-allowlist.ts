import type { RequestHandler } from "express";

import { env, getAdminIpWhitelist } from "../config/env.js";

const allowlist = getAdminIpWhitelist();

/** Derive the client IP honoring TRUST_PROXY_HOPS. */
function clientIp(req: Parameters<RequestHandler>[0]): string {
  if (env.TRUST_PROXY_HOPS > 0) {
    const forwarded = req.headers["x-forwarded-for"];
    const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const first = raw?.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.ip ?? req.socket.remoteAddress ?? "";
}

/**
 * Gateway edge guard for the entire `/admin/*` surface. An empty allowlist
 * means allow all (dev); otherwise non-listed IPs get 403.
 */
export const adminIpAllowlist: RequestHandler = (req, res, next) => {
  if (allowlist.length === 0) {
    next();
    return;
  }

  const ip = clientIp(req);
  if (allowlist.includes(ip)) {
    next();
    return;
  }

  res.status(403).json({
    success: false,
    message: "You do not have permission to access this resource.",
  });
};
