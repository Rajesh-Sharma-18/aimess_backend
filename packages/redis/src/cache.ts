import type Redis from "ioredis";

export async function cacheGetJson<T>(
  redis: Redis,
  key: string
): Promise<T | null> {
  const raw = await redis.get(key);
  if (raw === null) {
    return null;
  }

  return JSON.parse(raw) as T;
}

export async function cacheSetJson(
  redis: Redis,
  key: string,
  value: unknown,
  ttlSeconds: number
): Promise<void> {
  await redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
}

export async function cacheDel(redis: Redis, ...keys: string[]): Promise<void> {
  if (keys.length === 0) {
    return;
  }

  await redis.del(...keys);
}

/** Delete all keys matching `pattern` (uses SCAN, safe for dev/small key sets). */
export async function cacheDelByPattern(
  redis: Redis,
  pattern: string
): Promise<void> {
  const stream = redis.scanStream({ match: pattern, count: 100 });

  await new Promise<void>((resolve, reject) => {
    stream.on("data", (keys: string[]) => {
      if (keys.length > 0) {
        void redis.del(...keys);
      }
    });
    stream.on("end", () => resolve());
    stream.on("error", reject);
  });
}
