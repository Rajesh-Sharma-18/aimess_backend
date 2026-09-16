import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { Request, RequestHandler, Response } from "express";

import { logger } from "@aimess/logger";
import {
  buildIpAllowList,
  rateLimitHandler,
  sendApiError,
} from "@aimess/utils";

import { env, getAdminIpWhitelist } from "../config/env.js";
import { verifyAdminAccessToken } from "../lib/admin-jwt.js";

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

const ipKey = (req: Request): string => ipKeyGenerator(req.ip ?? "unknown");

/**
 * The VERIFIED admin id, else the caller's IP. Mirrors the gateway's `admin`
 * scope: nothing a browser can send without a valid admin token — a forged or
 * user token, an "is admin" header — reaches an admin's allowance.
 */
function adminOrIpKey(req: Request): string {
  const header = req.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) {
    try {
      return `a:${verifyAdminAccessToken(header.slice(7).trim()).adminId}`;
    } catch {
      // Not a valid admin token — rejected by adminAuth; bucketed by address.
    }
  }
  return ipKey(req);
}

function makeHandler(rule: string) {
  const respond = rateLimitHandler();
  return (req: Request, res: Response): void => {
    logger.warn("rate_limit_exceeded", {
      service: "backoffice-service",
      rule,
      ip: req.ip,
      method: req.method,
      endpoint: req.originalUrl.split("?")[0],
    });
    respond(req, res);
  };
}

const isReadMethod = (req: Request): boolean =>
  req.method === "GET" || req.method === "HEAD";

/**
 * Admin reads, per admin per minute — mirrors the gateway's `admin.read`. The
 * single `admin.global` bucket this replaces (100 per 15 min, reads and writes
 * together, per IP) was exhausted by ordinary Dashboard use.
 */
export const adminReadRateLimiter: RequestHandler = rateLimit({
  windowMs: 60 * 1000,
  max: env.ADMIN_READ_RATE_LIMIT_MAX,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  validate: { trustProxy: env.TRUST_PROXY_HOPS > 0, keyGeneratorIpFallback: false },
  skip: (req) => !isReadMethod(req),
  keyGenerator: adminOrIpKey,
  handler: makeHandler("admin.read"),
});

/** Admin mutations, per admin per minute — mirrors the gateway's `admin.write`. */
export const adminWriteRateLimiter: RequestHandler = rateLimit({
  windowMs: 60 * 1000,
  max: env.ADMIN_WRITE_RATE_LIMIT_MAX,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  validate: { trustProxy: env.TRUST_PROXY_HOPS > 0, keyGeneratorIpFallback: false },
  skip: (req) => isReadMethod(req) || req.method === "OPTIONS",
  keyGenerator: adminOrIpKey,
  handler: makeHandler("admin.write"),
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
  keyGenerator: ipKey,
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

/**
 * Null when enforcement is switched off, so the guard below takes the same
 * `next()` path an unconfigured list already took — no source-address check,
 * and crucially no `admin_ip_denied` audit line, which would otherwise claim a
 * perimeter that is not running.
 */
const allowlist = env.ADMIN_IP_WHITELIST_ENABLED
  ? buildIpAllowList(getAdminIpWhitelist(), (entry, reason) => {
      logger.warn(`ADMIN_IP_WHITELIST: ignoring "${entry}" — ${reason}`);
    })
  : null;

// Once, at import — not per request. Which of the two states a deployment is in
// is the first thing anyone asks when an admin call 403s, or when one does not.
logger.info(
  `Admin IP whitelist enforcement: ${
    env.ADMIN_IP_WHITELIST_ENABLED ? "enabled" : "disabled"
  }`,
  { service: "backoffice-service" }
);

/**
 * Source-address allowlist for the whole admin surface.
 *
 * `ADMIN_IP_WHITELIST` was declared in this service's config and read by
 * nothing, which is why the nginx comment asserting the service enforced it was
 * false. An empty list still means allow-all for local development, but
 * `config/env.ts` refuses to boot a production instance with an empty list, so
 * production cannot silently be in that state.
 *
 * `ADMIN_IP_WHITELIST_ENABLED=false` is how a deployment says it has no IP
 * perimeter — the one state an operator could not previously express without
 * spelling allow-all as a CIDR the production assertion (rightly) refuses. It
 * skips ONLY this check: the surface keeps its rate limiters, admin JWT
 * verification, RBAC, lockout and audit logging.
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
