import Redis from "ioredis";

import { logger } from "@aimess/logger";

import { env } from "./env.js";

const redisConfig = {
  host: env.REDIS_HOST,
  port: env.REDIS_PORT,
  lazyConnect: true,
  maxRetriesPerRequest: null,
};

export const redis = new Redis.default(redisConfig);

let cacheEnabled = true;

/** Whether Redis is connected and usable for caching. */
export function isChatCacheReady(): boolean {
  return cacheEnabled && redis.status === "ready";
}

export async function connectChatRedis(): Promise<void> {
  try {
    await redis.connect();
    logger.info("Redis connected");
  } catch (error) {
    disableChatCache();
    logger.warn(
      "Redis connection failed — chat-service will run without Redis"
    );
    logger.warn(error);
  }
}

/** Disable cache when Redis is unavailable (graceful degradation). */
export function disableChatCache(): void {
  cacheEnabled = false;
}

/** Create a duplicate client for Socket.IO Redis adapter (subscriber). */
export function createRedisSubClient(): InstanceType<typeof Redis.default> {
  return new Redis.default(redisConfig);
}
