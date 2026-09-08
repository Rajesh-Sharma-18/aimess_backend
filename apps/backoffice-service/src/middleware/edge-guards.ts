import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { Request, RequestHandler, Response } from "express";

import { logger } from "@aimess/logger";
import { buildIpAllowList, sendApiError } from "@aimess/utils";

import { env, getAdminIpWhitelist } from "../config/env.js";

/**
 * Edge guards for the admin API, applied inside this service.
 *
 * The gateway wraps `/admin/*` in a rate limiter, an IP allowlist and an edge
 * JWT check — but the admin API is also published on its own vhost that routes
 * straight to this process, so none of that ran. `createApp()` mounted helmet,
 * CORS, JSON, locale, audit, health and the routes, and nothing else. The
 * result was an unauthenticated, unthrottled, IP-unrestricted admin credential
 * endpoint: `POST /v1/auth/login`, plus `/forgot-password`, `/verify-otp` and
 * `/resend-otp` for unlimited OTP brute force against admin password reset. A
 * successful takeover yields user ban/suspend, community deletion, audit-log
 * access and the whole moderation surface.
 *
 * These deliberately MIRROR the gateway's limits rather than inventing new
 * ones, so an admin sees the same behaviour whichever path they arrive by, and
 * so the deployment comment claiming "the service already enforces the
 * allowlist" becomes true instead of aspirational.
 */

function makeHandler(rule: string) {
  return (req: Request, res: Response): void => {
    logger.warn("rate_limit_exceeded", {
      service: "backoffice-service",
      rule,
      ip: req.ip,
      method: req.method,
      endpoint: req.originalUrl.split("?")[0],
    });
    sendApiError(req, res, { statusCode: 429, messageKey: "RATE_LIMITED" });
  };
}

/**
 * Whole admin surface. Low volume, high privilege, isolated from user traffic —
 * mirrors the gateway's `admin.global`.
 */
export const adminSurfaceRateLimiter: RequestHandler = rateLimit({
  windowMs: env.ADMIN_RATE_LIMIT_WINDOW_MINUTES * 60 * 1000,
  max: env.ADMIN_RATE_LIMIT_MAX,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  validate: { trustProxy: env.TRUST_PROXY_HOPS > 0 },
  keyGenerator: (req: Request) => ipKeyGenerator(req.ip ?? "unknown"),
  handler: makeHandler("admin.global"),
});

/**
 * Credential and OTP endpoints. IP-scoped by necessity — the caller has no
 * credential yet, and per-IP is the axis a credential-stuffing run varies
 * least. Mirrors the gateway's `admin.login`.
 */
export const adminCredentialRateLimiter: RequestHandler = rateLimit({
  windowMs: env.ADMIN_RATE_LIMIT_WINDOW_MINUTES * 60 * 1000,
  max: env.ADMIN_LOGIN_RATE_LIMIT_MAX,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  validate: { trustProxy: env.TRUST_PROXY_HOPS > 0 },
  keyGenerator: (req: Request) => ipKeyGenerator(req.ip ?? "unknown"),
  handler: makeHandler("admin.login"),
});

/** Paths the credential limiter covers, relative to the `/v1` mount. */
export const ADMIN_CREDENTIAL_PATHS = [
  "/auth/login",
  "/auth/refresh",
  "/auth/forgot-password",
  "/auth/verify-otp",
  "/auth/resend-otp",
  "/auth/reset-password",
] as const;

const allowlist = buildIpAllowList(getAdminIpWhitelist(), (entry, reason) => {
  logger.warn(`ADMIN_IP_WHITELIST: ignoring "${entry}" — ${reason}`);
});

/**
 * Source-address allowlist for the whole admin surface.
 *
 * `ADMIN_IP_WHITELIST` was declared in this service's config and read by
 * nothing, which is why the nginx comment asserting the service enforced it was
 * false. An empty list still means allow-all for local development, but
 * `config/env.ts` refuses to boot a production instance with an empty list, so
 * production cannot silently be in that state.
 *
 * The address comes from `req.ip`, which honours the configured proxy hop
 * count — never a hand-parsed `X-Forwarded-For`, whose leftmost entry is
 * supplied by the caller and would let an attacker name an allowlisted office
 * address.
 */
export const adminIpAllowlist: RequestHandler = (req, res, next) => {
  if (allowlist === null) {
    next();
    return;
  }

  const ip = req.ip ?? req.socket.remoteAddress ?? "";
  if (allowlist.check(ip)) {
    next();
    return;
  }

  logger.warn("admin_ip_denied", {
    service: "backoffice-service",
    ip,
    endpoint: req.originalUrl.split("?")[0],
  });
  sendApiError(req, res, { statusCode: 403, messageKey: "FORBIDDEN" });
};
