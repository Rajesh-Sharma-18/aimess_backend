import { Router } from "express";

import { prisma } from "../config/prisma.js";
import { redis } from "../config/redis.js";
import { env } from "../config/env.js";
import { SERVICE_SLUG, SERVICE_TITLE } from "../constants/index.js";

export const healthRouter: Router = Router();

/** Liveness — no dependency checks (k8s/gateway probe). */
healthRouter.get("/", (_req, res) => {
  res.status(200).json({
    success: true,
    service: SERVICE_SLUG,
    title: SERVICE_TITLE,
    environment: env.NODE_ENV,
    timestamp: new Date().toISOString(),
  });
});

/** Readiness — admin_db + Redis must be reachable. 200 ok / 503 not-ready. */
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
    res.status(ready ? 200 : 503).json({
      success: ready,
      service: SERVICE_SLUG,
      checks,
      timestamp: new Date().toISOString(),
    });
  })();
});
