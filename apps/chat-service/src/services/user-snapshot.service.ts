import { logger } from "@aimess/logger";

import type { CacheRepository } from "../repositories/cache.repository.js";
import { fetchUsersBatch } from "../lib/user-service-client.js";

export interface UserSnapshot {
  userId: string;
  displayName: string;
  avatar: string;
  memberId: string;
  isDeletedUser: boolean;
  isOnline: boolean;
}

/**
 * User snapshot service — fetches user info from Redis cache.
 * Falls back to a minimal placeholder if not cached.
 * In production, a background worker periodically syncs from user-service.
 */
export class UserSnapshotService {
  /**
   * Get user snapshots for a list of user IDs.
   * Returns a Map of userId → snapshot data.
   */
  async getUserSnapshotsMap(
    userIds: string[],
    cacheRepo: CacheRepository
  ): Promise<Map<string, Record<string, unknown>>> {
    const uniqueIds = [...new Set(userIds.filter(Boolean))];
    if (!uniqueIds.length) return new Map();

    try {
      const cached = await cacheRepo.getUserSnapshots(uniqueIds);

      const missingIds = uniqueIds.filter((id) => !cached.has(id));

      if (missingIds.length > 0) {
        const fetched = await fetchUsersBatch(missingIds);
        for (const user of fetched) {
          const snapshot: Record<string, unknown> = {
            userId: user.userId,
            displayName: user.displayName,
            avatar: user.avatar,
            memberId: user.username,
            isDeletedUser: false,
            isOnline: user.isOnline,
          };
          cached.set(user.userId, snapshot);
          cacheRepo.setUserSnapshot(user.userId, snapshot).catch(() => {});
        }
      }

      for (const id of uniqueIds) {
        if (!cached.has(id)) {
          cached.set(id, {
            userId: id,
            displayName: "",
            avatar: "",
            memberId: "",
            isDeletedUser: false,
            isOnline: false,
          });
        }
      }

      return cached;
    } catch (error) {
      logger.warn(`UserSnapshotService|getUserSnapshotsMap|error=${error}`);
      const fallback = new Map<string, Record<string, unknown>>();
      for (const id of uniqueIds) {
        fallback.set(id, {
          userId: id,
          displayName: "",
          avatar: "",
          memberId: "",
          isDeletedUser: false,
          isOnline: false,
        });
      }
      return fallback;
    }
  }

  /**
   * Resolve user identity with fallback.
   * Prefers snapshot data over fallback values.
   */
  resolveUserIdentity(
    snapshot: Record<string, unknown> | null,
    fallback: { userId?: string; displayName?: string; avatar?: string }
  ): { displayName: string; avatar: string; isDeletedUser: boolean } {
    if (!snapshot) {
      return {
        displayName: fallback.displayName || "",
        avatar: fallback.avatar || "",
        isDeletedUser: false,
      };
    }

    return {
      displayName:
        (snapshot.displayName as string) || fallback.displayName || "",
      avatar: (snapshot.avatar as string) || fallback.avatar || "",
      isDeletedUser: snapshot.isDeletedUser === true,
    };
  }
}
