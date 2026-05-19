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
      maxRetriesPerRequest: null,
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
