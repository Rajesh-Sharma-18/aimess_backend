import { connectRedis } from "@aimess/redis";

import { env } from "./env.js";

export const redis = connectRedis({
  host: env.REDIS_HOST,
  port: env.REDIS_PORT,
  password: env.REDIS_PASSWORD,
});

export async function connectMediaRedis(): Promise<void> {
  await redis.connect();
}
