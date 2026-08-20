import type { RequestHandler } from "express";
import jwt from "jsonwebtoken";

import { sendApiError } from "@aimess/utils";

import { env } from "../config/env.js";

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

/**
 * 401 in the shared envelope. This wrote `{ success, message }` directly, so an
 * admin client got no `error.code` to branch on and no `requestId` to quote —
 * the two things every other 401 on the platform carries.
 */
function unauthorized(
  req: Parameters<RequestHandler>[0],
  res: Parameters<RequestHandler>[1],
  messageKey: string
): void {
  sendApiError(req, res, { statusCode: 401, messageKey });
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
    unauthorized(req, res, "AUTH_UNAUTHORIZED");
    return;
  }

  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    unauthorized(req, res, "UNAUTHORIZED");
    return;
  }
  const token = header.slice("Bearer ".length).trim();
  if (!token) {
    unauthorized(req, res, "UNAUTHORIZED");
    return;
  }

  try {
    jwt.verify(token, env.JWT_ADMIN_SECRET, { algorithms: ["HS256"] });
    next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      unauthorized(req, res, "AUTH_TOKEN_EXPIRED");
    } else {
      unauthorized(req, res, "AUTH_INVALID_TOKEN");
    }
  }
};
