import { logger } from "@aimess/logger";
import { Router, type IRouter } from "express";
import { createProxyMiddleware } from "http-proxy-middleware";

import { env } from "../config/env.js";
import { adminIpAllowlist } from "../middleware/admin-ip-allowlist.js";
import { adminJwt } from "../middleware/admin-jwt.js";
import {
  adminLoginRateLimiter,
  adminRateLimiter,
} from "../middleware/rate-limit.js";

/**
 * Admin edge router, mounted at `/admin`. Order:
 *   adminRateLimiter → adminIpAllowlist → (login paths: stricter limiter)
 *   → adminJwt (skips public paths) → proxy → backoffice-service.
 *
 * Path rewrite: `/admin/v1/auth/login` → `/v1/auth/login` (strip `/admin`),
 * matching backoffice-service which mounts its routes at `/v1`.
 */
export function createAdminRouter(): IRouter {
  const adminRouter: IRouter = Router();

  // Whole-surface controls.
  adminRouter.use(adminRateLimiter);
  adminRouter.use(adminIpAllowlist);

  // Stricter throttle on the public, unauthenticated auth paths (before the JWT
  // skip-list): login/refresh plus the password-reset flow (OTP issuance and
  // verification are brute-force-sensitive and reachable without a bearer).
  for (const sensitivePath of [
    "/v1/auth/login",
    "/v1/auth/refresh",
    "/v1/auth/forgot-password",
    "/v1/auth/verify-otp",
    "/v1/auth/resend-otp",
    "/v1/auth/reset-password",
  ]) {
    adminRouter.use(sensitivePath, adminLoginRateLimiter);
  }

  // Edge JWT (signature + exp); public paths are skipped inside the middleware.
  adminRouter.use(adminJwt);

  const target = env.BACKOFFICE_SERVICE_URL;
  if (!target) {
    adminRouter.use((_req, res) => {
      res.status(503).json({
        success: false,
        message:
          "This service is currently unavailable. Please contact support.",
      });
    });
    return adminRouter;
  }

  adminRouter.use(
    createProxyMiddleware({
      target,
      changeOrigin: true,
      // Express has already stripped the `/admin` mount, so `path` arrives as
      // `/v1/...` — exactly what backoffice serves. Forward it as-is (the
      // `^/admin` strip is a defensive no-op in case the mount ever changes).
      // Do NOT prepend `/v1` again or the upstream gets `/v1/v1/...`.
      pathRewrite: (path) => path.replace(/^\/admin/, "") || "/",
      on: {
        error: (error, _req, res) => {
          logger.error("backoffice proxy error");
          logger.error(error);
          if (res && "writeHead" in res && !res.headersSent) {
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                success: false,
                message:
                  "Service temporarily unavailable. Please try again later.",
              })
            );
          }
        },
      },
    })
  );

  return adminRouter;
}
