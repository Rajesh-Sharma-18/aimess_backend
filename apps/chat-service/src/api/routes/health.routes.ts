import { Router, type Router as RouterType } from "express";

import { redis } from "../../config/redis.js";
import {
  fetchUsersBatch,
  fetchAccountsBatch,
} from "../../lib/user-service-client.js";

const router = Router();

router.get("/health", (_req, res) => {
  res.status(200).json({
    success: true,
    service: "chat-service",
    timestamp: new Date().toISOString(),
  });
});

/**
 * DEBUG ONLY — remove before production.
 * GET /debug/snapshot/:userId
 * Clears the Redis snapshot cache for this userId, re-fetches from user-service
 * and auth-service, and returns exactly what the snapshot service would store.
 */
router.get("/debug/snapshot/:userId", async (req, res) => {
  const { userId } = req.params;
  const cacheKey = `user:snapshot:${userId}`;

  // 1. What is currently in Redis?
  const cached = await redis.get(cacheKey).catch(() => null);
  const cachedParsed = cached ? JSON.parse(cached) : null;

  // 2. Delete stale cache
  await redis.del(cacheKey).catch(() => null);

  // 3. Call user-service
  const fromUserService = await fetchUsersBatch([userId]);

  // 4. Call auth-service fallback
  const fromAuthService = await fetchAccountsBatch([userId]);

  res.json({
    staleCache: cachedParsed,
    fromUserService,
    fromAuthService,
    resolvedSenderName:
      fromUserService[0]?.displayName ||
      fromUserService[0]?.username ||
      fromAuthService[0]?.account ||
      "(empty — check services)",
  });
});

export const healthRoutes: RouterType = router;
