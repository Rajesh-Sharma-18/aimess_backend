import Redis from "ioredis";

let redis: Redis | undefined;

export const connectRedis = ({
  host,
  port,
}: {
  host: string;
  port: number;
}): Redis => {
  if (!redis) {
    redis = new Redis({
      host,
      port,
      lazyConnect: true,
      // Fail fast when Redis is unreachable/misconfigured so callers' try/catch
      // can fall back instead of the request hanging forever. (A hung command
      // cannot be caught — these bounds turn a hang into a fast rejection.)
      connectTimeout: 5000,
      commandTimeout: 2000,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: (attempt) => Math.min(attempt * 200, 2000),
    });
    // Without a listener, ioredis throws unhandled 'error' events when Redis is
    // down and crashes the process; log + swallow so the service stays up.
    redis.on("error", () => {
      /* connection errors surface as command rejections; avoid crashing here */
    });
  }
  return redis;
};

export function getRedis(): Redis {
  if (!redis) {
    throw new Error("Redis client not initialized. Call connectRedis() first.");
  }
  return redis;
}
