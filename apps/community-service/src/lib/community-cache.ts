import { cacheDelByPattern, cacheGetJson, cacheSetJson } from "@aimess/redis";
import { logger } from "@aimess/logger";

import { env } from "../config/env.js";
import { isCommunityCacheReady, redis } from "../config/redis.js";

const KEY_PREFIX = "aimess:community";

type AvailabilityCache = {
  available: boolean;
};

function nameAvailabilityKey(
  name: string,
  excludeId: string | undefined
): string {
  const owner = excludeId ?? "_";
  return `${KEY_PREFIX}:name:avail:${name}:${owner}`;
}

function handleAvailabilityKey(
  handle: string,
  excludeId: string | undefined
): string {
  const owner = excludeId ?? "_";
  return `${KEY_PREFIX}:handle:avail:${handle}:${owner}`;
}

function nameAvailabilityPattern(name: string): string {
  return `${KEY_PREFIX}:name:avail:${name}:*`;
}

function handleAvailabilityPattern(handle: string): string {
  return `${KEY_PREFIX}:handle:avail:${handle}:*`;
}

async function withCache<T>(
  operation: () => Promise<T>,
  fallback: T
): Promise<T> {
  if (!isCommunityCacheReady()) {
    return fallback;
  }

  try {
    return await operation();
  } catch (error) {
    logger.warn("Redis cache operation failed, falling back to database");
    logger.warn(error);
    return fallback;
  }
}

export const communityCache = {
  async getNameAvailability(
    name: string,
    excludeId: string | undefined
  ): Promise<AvailabilityCache | null> {
    return withCache(
      () =>
        cacheGetJson<AvailabilityCache>(
          redis,
          nameAvailabilityKey(name, excludeId)
        ),
      null
    );
  },

  async setNameAvailability(
    name: string,
    excludeId: string | undefined,
    available: boolean
  ): Promise<void> {
    const ttl = available
      ? env.REDIS_CACHE_NAME_AVAIL_TTL_SEC
      : env.REDIS_CACHE_NAME_TAKEN_TTL_SEC;

    await withCache(async () => {
      await cacheSetJson(
        redis,
        nameAvailabilityKey(name, excludeId),
        { available },
        ttl
      );
    }, undefined);
  },

  async invalidateNameAvailability(name: string): Promise<void> {
    await withCache(async () => {
      await cacheDelByPattern(redis, nameAvailabilityPattern(name));
    }, undefined);
  },

  async getHandleAvailability(
    handle: string,
    excludeId: string | undefined
  ): Promise<AvailabilityCache | null> {
    return withCache(
      () =>
        cacheGetJson<AvailabilityCache>(
          redis,
          handleAvailabilityKey(handle, excludeId)
        ),
      null
    );
  },

  async setHandleAvailability(
    handle: string,
    excludeId: string | undefined,
    available: boolean
  ): Promise<void> {
    const ttl = available
      ? env.REDIS_CACHE_NAME_AVAIL_TTL_SEC
      : env.REDIS_CACHE_NAME_TAKEN_TTL_SEC;

    await withCache(async () => {
      await cacheSetJson(
        redis,
        handleAvailabilityKey(handle, excludeId),
        { available },
        ttl
      );
    }, undefined);
  },

  async invalidateHandleAvailability(handle: string): Promise<void> {
    await withCache(async () => {
      await cacheDelByPattern(redis, handleAvailabilityPattern(handle));
    }, undefined);
  },
};
