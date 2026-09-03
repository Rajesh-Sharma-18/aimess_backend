import { connectRedis } from "@aimess/redis";

import { env } from "./env.js";

/** Shared Redis client for auth-service (same pattern as `config/prisma.ts`). */
export const redis = connectRedis({
  host: env.REDIS_HOST,
  port: env.REDIS_PORT,
  password: env.REDIS_PASSWORD,
  tls: env.REDIS_TLS,
});

export async function connectAuthRedis(): Promise<void> {
  await redis.connect();
}
