import RedisModule, { Cluster } from "ioredis";
import type { Redis } from "ioredis";

import { logger } from "@aimess/logger";

import { env } from "./env.js";

const sharedOptions = {
  lazyConnect: true,
  maxRetriesPerRequest: null,
};

// Parse REDIS_CLUSTER_NODES when set (e.g. "127.0.0.1:7001,127.0.0.1:7002,127.0.0.1:7003")
const clusterNodes = env.REDIS_CLUSTER_NODES
  ? env.REDIS_CLUSTER_NODES.split(",").map((addr) => {
      const [host, portStr] = addr.trim().split(":");
      return { host, port: parseInt(portStr, 10) };
    })
  : null;

function createClient(enableAutoPipelining: boolean): Redis | Cluster {
  if (clusterNodes) {
    return new Cluster(clusterNodes, {
      redisOptions: { ...sharedOptions },
      enableAutoPipelining,
    });
  }
  return new RedisModule.default({
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    ...sharedOptions,
    enableAutoPipelining,
  });
}

export const redis: Redis | Cluster = createClient(true);
// Suppress unhandled ioredis error events emitted during retry backoff
redis.on("error", () => {});

let cacheEnabled = true;

export function isChatCacheReady(): boolean {
  return cacheEnabled && redis.status === "ready";
}

export async function connectChatRedis(): Promise<void> {
  if (clusterNodes) {
    // Cluster client connects on first command; no explicit connect() needed
    logger.info("Redis Cluster mode enabled");
    return;
  }
  try {
    await (redis as Redis).connect();
    logger.info("Redis connected");
  } catch (error) {
    disableChatCache();
    logger.warn(
      "Redis connection failed — chat-service will run without Redis"
    );
    logger.warn(error);
  }
}

export function disableChatCache(): void {
  cacheEnabled = false;
}

/** Create a separate subscriber client for the Socket.IO Redis adapter.
 *  Auto-pipelining MUST be disabled on subscriber clients. */
export function createRedisSubClient(): Redis | Cluster {
  const sub = createClient(false);
  sub.on("error", () => {});
  return sub;
}
