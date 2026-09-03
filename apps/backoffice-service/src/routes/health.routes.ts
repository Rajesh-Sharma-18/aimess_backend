import { Router } from "express";

import { prisma } from "../config/prisma.js";
import { redis } from "../config/redis.js";
import { env, getAdminIpWhitelist } from "../config/env.js";
import { SERVICE_SLUG, SERVICE_TITLE } from "../constants/index.js";

export const healthRouter: Router = Router();

/**
 * Liveness — no dependency checks (k8s/gateway probe).
 *
 * Minimal by design. This endpoint is mounted above the admin guards and the
 * admin vhost proxies every path to this service, so it is reachable from
 * anywhere. It used to answer with the service slug, its human title and
 * `NODE_ENV`, which confirmed to an unauthenticated caller that the admin
 * service exists at that hostname, named it, and disclosed the environment —
 * free reconnaissance against a surface that had no rate limiting at the time.
 * The gateway's own `/health` is already minimal in exactly this way.
 */
healthRouter.get("/", (_req, res) => {
  res.status(200).json({ success: true });
});

/**
 * Readiness — admin_db + Redis must be reachable. 200 ok / 503 not-ready.
 *
 * The per-dependency booleans tell an attacker exactly when the admin service's
 * backing store is degraded, which is when to time an attempt against it. They
 * are kept for the operators who need them, but only for callers that can see
 * them legitimately: an allowlisted source address, or a loopback probe (the
 * proxy's own health check originates there). Everyone else gets the same
 * 200/503 verdict with no detail, so orchestration still works.
 */
healthRouter.get("/ready", (_req, res) => {
  void (async () => {
    const checks: { postgres: boolean; redis: boolean } = {
      postgres: false,
      redis: false,
    };

    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.postgres = true;
    } catch {
      checks.postgres = false;
    }

    try {
      const pong = await redis.ping();
      checks.redis = pong === "PONG";
    } catch {
      checks.redis = false;
    }

    const ready = checks.postgres && checks.redis;
    const ip = _req.ip ?? _req.socket.remoteAddress ?? "";
    const allowlist = getAdminIpWhitelist();
    const isTrustedProbe =
      ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(ip) ||
      (allowlist.length > 0 && allowlist.includes(ip));

    res.status(ready ? 200 : 503).json({
      success: ready,
      ...(isTrustedProbe
        ? {
            service: SERVICE_SLUG,
            title: SERVICE_TITLE,
            environment: env.NODE_ENV,
            checks,
            timestamp: new Date().toISOString(),
          }
        : {}),
    });
  })();
});
