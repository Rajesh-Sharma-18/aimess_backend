import {
  cacheDel,
  cacheDelByPattern,
  cacheGetJson,
  cacheSetJson,
} from "@aimess/redis";
import { logger } from "@aimess/logger";

import { env } from "../config/env.js";
import { isUserCacheReady, redis } from "../config/redis.js";
import type { ProfileGender } from "../generated/prisma/client.js";
import type { AuthAccountSummary } from "../types/auth-account.types.js";

const KEY_PREFIX = "aimess:user";

export type CachedProfileRecord = {
  userId: string;
  username: string;
  account: string | null;
  firstName: string;
  lastName: string;
  bio: string | null;
  dateOfBirth: string;
  gender: ProfileGender | null;
  avatarUrl: string | null;
  updatedAt: string;
  isGoogleLogin: boolean;
};

type UsernameAvailabilityCache = {
  available: boolean;
};

function usernameTakenKey(username: string): string {
  return `${KEY_PREFIX}:username:taken:${username}`;
}

function usernameAvailabilityKey(
  username: string,
  excludeUserId: string | undefined
): string {
  const owner = excludeUserId ?? "_";
  return `${KEY_PREFIX}:username:avail:${username}:${owner}`;
}

function profileRecordKey(userId: string): string {
  return `${KEY_PREFIX}:profile:record:${userId}`;
}

function accountSummaryKey(userId: string): string {
  return `${KEY_PREFIX}:account:summary:${userId}`;
}

function usernameAvailabilityPattern(username: string): string {
  return `${KEY_PREFIX}:username:avail:${username}:*`;
}

async function withCache<T>(
  operation: () => Promise<T>,
  fallback: T
): Promise<T> {
  if (!isUserCacheReady()) {
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

export const userCache = {
  async getUsernameTaken(username: string): Promise<boolean | null> {
    return withCache(async () => {
      const value = await redis.get(usernameTakenKey(username));
      if (value === null) {
        return null;
      }
      return value === "1";
    }, null);
  },

  async markUsernameTaken(username: string): Promise<void> {
    await withCache(async () => {
      await redis.set(
        usernameTakenKey(username),
        "1",
        "EX",
        env.REDIS_CACHE_USERNAME_TAKEN_TTL_SEC
      );
    }, undefined);
  },

  async markUsernameAvailable(username: string): Promise<void> {
    await withCache(async () => {
      await cacheDel(redis, usernameTakenKey(username));
    }, undefined);
  },

  async getUsernameAvailability(
    username: string,
    excludeUserId: string | undefined
  ): Promise<UsernameAvailabilityCache | null> {
    return withCache(
      () =>
        cacheGetJson<UsernameAvailabilityCache>(
          redis,
          usernameAvailabilityKey(username, excludeUserId)
        ),
      null
    );
  },

  async setUsernameAvailability(
    username: string,
    excludeUserId: string | undefined,
    available: boolean
  ): Promise<void> {
    const ttl = available
      ? env.REDIS_CACHE_USERNAME_AVAIL_TTL_SEC
      : env.REDIS_CACHE_USERNAME_TAKEN_TTL_SEC;

    await withCache(async () => {
      await cacheSetJson(
        redis,
        usernameAvailabilityKey(username, excludeUserId),
        { available },
        ttl
      );
    }, undefined);
  },

  async invalidateUsernameAvailability(username: string): Promise<void> {
    await withCache(async () => {
      await cacheDelByPattern(redis, usernameAvailabilityPattern(username));
    }, undefined);
  },

  async getProfileRecord(userId: string): Promise<CachedProfileRecord | null> {
    return withCache(
      () => cacheGetJson<CachedProfileRecord>(redis, profileRecordKey(userId)),
      null
    );
  },

  async setProfileRecord(record: CachedProfileRecord): Promise<void> {
    await withCache(async () => {
      await cacheSetJson(
        redis,
        profileRecordKey(record.userId),
        record,
        env.REDIS_CACHE_PROFILE_TTL_SEC
      );
    }, undefined);
  },

  async invalidateProfile(userId: string): Promise<void> {
    await withCache(async () => {
      await cacheDel(redis, profileRecordKey(userId));
    }, undefined);
  },

  async getAccountSummary(userId: string): Promise<AuthAccountSummary | null> {
    return withCache(
      () => cacheGetJson<AuthAccountSummary>(redis, accountSummaryKey(userId)),
      null
    );
  },

  async setAccountSummary(
    userId: string,
    summary: AuthAccountSummary
  ): Promise<void> {
    await withCache(async () => {
      await cacheSetJson(
        redis,
        accountSummaryKey(userId),
        summary,
        env.REDIS_CACHE_ACCOUNT_TTL_SEC
      );
    }, undefined);
  },

  async onUsernameClaimed(username: string): Promise<void> {
    await this.markUsernameTaken(username);
    await this.invalidateUsernameAvailability(username);
  },

  async onUsernameReleased(username: string): Promise<void> {
    await this.markUsernameAvailable(username);
    await this.invalidateUsernameAvailability(username);
  },
};

export function toCachedProfileRecord(profile: {
  userId: string;
  username: string;
  account?: string | null;
  isGoogleLogin: boolean;
  firstName: string;
  lastName: string;
  bio: string | null;
  dateOfBirth: Date;
  gender: ProfileGender | null;
  avatarUrl: string | null;
  updatedAt: Date;
}): CachedProfileRecord {
  return {
    userId: profile.userId,
    username: profile.username,
    account: profile.account ?? null,
    isGoogleLogin: profile.isGoogleLogin,
    firstName: profile.firstName,
    lastName: profile.lastName,
    bio: profile.bio,
    dateOfBirth: profile.dateOfBirth.toISOString(),
    gender: profile.gender,
    avatarUrl: profile.avatarUrl,
    updatedAt: profile.updatedAt.toISOString(),
  };
}

export function fromCachedProfileRecord(record: CachedProfileRecord): {
  userId: string;
  username: string;
  account: string | null;
  isGoogleLogin: boolean;
  firstName: string;
  lastName: string;
  bio: string | null;
  dateOfBirth: Date;
  gender: ProfileGender | null;
  avatarUrl: string | null;
  updatedAt: Date;
  deletedAt: null;
} {
  return {
    userId: record.userId,
    username: record.username,
    account: record.account,
    isGoogleLogin: record.isGoogleLogin,
    firstName: record.firstName,
    lastName: record.lastName,
    bio: record.bio,
    dateOfBirth: new Date(record.dateOfBirth),
    gender: record.gender,
    avatarUrl: record.avatarUrl,
    updatedAt: new Date(record.updatedAt),
    deletedAt: null,
  };
}
