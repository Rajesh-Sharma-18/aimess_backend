import { connectRedis } from "@aimess/redis";

import { env } from "./env.js";

export const redis: ReturnType<typeof connectRedis> = connectRedis({
  host: env.REDIS_HOST,
  port: env.REDIS_PORT,
});

let cacheReady = false;

export function isCommunityCacheReady(): boolean {
  return cacheReady && env.REDIS_CACHE_ENABLED;
}

export async function connectCommunityRedis(): Promise<void> {
  if (!env.REDIS_CACHE_ENABLED) {
    return;
  }

  await redis.connect();
  cacheReady = true;
}

export function disableCommunityCache(): void {
  cacheReady = false;
}
