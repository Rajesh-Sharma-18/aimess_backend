import { connectRedis } from "@aimess/redis";

import { env } from "./env.js";

/**
 * Shared ioredis client for notifications-service (settings cache). Lazy-connects
 * on first command; cache helpers fall back gracefully when Redis is down.
 */
export const redis = connectRedis({
  host: env.REDIS_HOST,
  port: env.REDIS_PORT,
});
