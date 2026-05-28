import RedisModule from "ioredis";
import type { Redis } from "ioredis";
import { env } from "../config/env.js";

export function createGatewayRedisClients(): { pub: Redis; sub: Redis } {
  const opts = { lazyConnect: true, maxRetriesPerRequest: null as null };
  const pub = new RedisModule.default(env.REDIS_URL, opts) as Redis;
  const sub = new RedisModule.default(env.REDIS_URL, opts) as Redis;
  pub.on("error", () => {
    /* suppress until connected */
  });
  sub.on("error", () => {
    /* suppress until connected */
  });
  return { pub, sub };
}
