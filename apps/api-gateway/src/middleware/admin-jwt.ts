import type { RequestHandler } from "express";
import jwt from "jsonwebtoken";

import { env } from "../config/env.ts";

/**
 * Public admin paths (relative to the `/admin` mount) that must NOT require a
 * bearer token: single-step login, token refresh, and the password-reset flow
 * (a locked-out admin has no bearer, so these must be reachable unauthenticated).
 * Mirrors the public special-casing in routes/v1/index.ts.
 */
const PUBLIC_ADMIN_PATHS = new Set<string>([
  "/v1/auth/login",
  "/v1/auth/refresh",
  // Forgot-password flow — reachable without a bearer by design.
  "/v1/auth/forgot-password",
  "/v1/auth/verify-otp",
  "/v1/auth/resend-otp",
  "/v1/auth/reset-password",
  // Infra probes — no token (mirrors the public health routes in the spec).
  "/v1/health",
  "/v1/health/ready",
]);

function unauthorized(
  res: Parameters<RequestHandler>[1],
  message: string
): void {
  res.status(401).json({ success: false, message });
}

/**
 * Edge admin-JWT check: verifies signature + expiry only (NOT the jti
 * blacklist — that is enforced by backoffice-service). Skips public paths.
 */
export const adminJwt: RequestHandler = (req, res, next) => {
  if (PUBLIC_ADMIN_PATHS.has(req.path)) {
    next();
    return;
  }

  if (!env.JWT_ADMIN_SECRET) {
    // Misconfiguration: fail closed rather than forwarding unauthenticated.
    unauthorized(res, "Admin auth not configured");
    return;
  }

  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    unauthorized(res, "Unauthorized");
    return;
  }
  const token = header.slice("Bearer ".length).trim();
  if (!token) {
    unauthorized(res, "Unauthorized");
    return;
  }

  try {
    jwt.verify(token, env.JWT_ADMIN_SECRET);
    next();
  } catch {
    unauthorized(res, "Invalid or expired token");
  }
};
