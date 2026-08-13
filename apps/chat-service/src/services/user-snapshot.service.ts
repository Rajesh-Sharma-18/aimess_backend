import { DELETED_ACCOUNT_DISPLAY_NAME } from "@aimess/constants";
import { logger } from "@aimess/logger";

import type { CacheRepository } from "../repositories/cache.repository.js";
import {
  fetchUsersBatch,
  fetchAccountsBatch,
} from "../lib/user-service-client.js";

export interface UserSnapshot {
  userId: string;
  displayName: string;
  avatar: string;
  memberId: string;
  isDeletedUser: boolean;
  isOnline: boolean;
}

// Auth-service has an account but user-service hasn't consumed `user.registered`
// yet, so the profile (and its displayName) doesn't exist. Cache this placeholder
// briefly instead of the normal 1h TTL so it self-heals as soon as the profile
// shows up, instead of serving an empty displayName for up to an hour.
const INCOMPLETE_SNAPSHOT_TTL_SECONDS = 30;

/**
 * Best available display name, in priority order: fullName → displayName →
 * username → memberId → "Unknown User". Centralized here so every caller of
 * getUserSnapshotsMap resolves a name the same way instead of each serializer
 * inventing its own fallback (or none at all, which is how empty strings leak
 * into API responses).
 *
 * A deleted account short-circuits the whole chain. This is chat-service's
 * ONE name chokepoint — the private conversation list, private room details,
 * group member list, group roster, group pins, message reactions, read
 * receipts and invite links all route through it — so overriding here is what
 * makes "Deleted Account" appear on every one of those surfaces at once,
 * rather than each of them hardcoding the string. Checked BEFORE the candidate
 * chain because a stale snapshot may still carry the old memberId.
 */
export function resolveDisplayName(
  snapshot: Record<string, unknown> | null | undefined
): string {
  if (!snapshot) return "Unknown User";
  if (snapshot.isDeletedUser === true) return DELETED_ACCOUNT_DISPLAY_NAME;
  const candidates = [
    snapshot.fullName,
    snapshot.displayName,
    snapshot.username,
    snapshot.memberId,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }
  }
  return "Unknown User";
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
            // Already anonymized upstream for deleted accounts (displayName is
            // the shared literal, username/avatar are ""); nothing to blank here.
            displayName: user.displayName,
            avatar: user.avatar,
            memberId: user.username,
            isDeletedUser: user.isDeleted,
            // A deleted account is never online. Presence is separately masked
            // on read, but pinning it false here stops a cached snapshot from
            // ever describing the account as active.
            isOnline: user.isDeleted ? false : user.isOnline,
          };
          cached.set(user.userId, snapshot);
          cacheRepo.setUserSnapshot(user.userId, snapshot).catch(() => {});
        }
      }

      // Still missing after user-service? Fall back to auth-service account name.
      // This happens when user-service has no profile yet (user.registered event not consumed).
      //
      // A DELETED user never reaches here: user-service returns deleted
      // profiles (anonymized) rather than omitting them, so the id is already
      // in `cached` above. And if the profile row genuinely never existed,
      // auth-service's bulkGetAccounts filters deleted rows out — so this path
      // can never resurrect a deleted account's login handle either way.
      const stillMissingIds = uniqueIds.filter((id) => !cached.has(id));
      if (stillMissingIds.length > 0) {
        const accounts = await fetchAccountsBatch(stillMissingIds);
        for (const entry of accounts) {
          const snapshot: Record<string, unknown> = {
            userId: entry.userId,
            displayName: "", // no full name yet
            avatar: "",
            memberId: entry.account, // account = the login username
            username: entry.account,
            isDeletedUser: false,
            isOnline: false,
          };
          cached.set(entry.userId, snapshot);
          cacheRepo
            .setUserSnapshot(
              entry.userId,
              snapshot,
              INCOMPLETE_SNAPSHOT_TTL_SECONDS
            )
            .catch(() => {});
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
        displayName: fallback.displayName || "Unknown User",
        avatar: fallback.avatar || "",
        isDeletedUser: false,
      };
    }

    return {
      displayName: resolveDisplayName(snapshot) || fallback.displayName || "",
      avatar: (snapshot.avatar as string) || fallback.avatar || "",
      isDeletedUser: snapshot.isDeletedUser === true,
    };
  }
}
