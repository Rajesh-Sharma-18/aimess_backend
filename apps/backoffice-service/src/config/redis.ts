import { connectRedis } from "@aimess/redis";

import { env } from "./env.js";

/** Shared Redis client for backoffice-service (active-session + perms cache). */
export const redis = connectRedis({
  host: env.REDIS_HOST,
  port: env.REDIS_PORT,
});

export async function connectBackofficeRedis(): Promise<void> {
  await redis.connect();
}
