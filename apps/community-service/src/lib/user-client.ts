import { logger } from "@aimess/logger";
import { env } from "../config/env.js";

export type UserSnapshot = {
  userId: string;
  username: string;
  displayName: string;
  avatarObjectKey: string | null;
};

type BulkSnapshotResponse = {
  success: boolean;
  data?: { users: UserSnapshot[] };
};

const FALLBACK_SNAPSHOT = (userId: string): UserSnapshot => ({
  userId,
  username: userId,
  displayName: "Unknown",
  avatarObjectKey: null,
});

export async function fetchUserSnapshots(
  userIds: string[]
): Promise<Map<string, UserSnapshot>> {
  if (userIds.length === 0) return new Map();

  const url = `${env.USER_SERVICE_URL.replace(/\/$/, "")}/api/v1/users/internal/bulk-snapshot?userIds=${userIds.join(",")}`;

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(env.USER_SERVICE_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`User snapshot fetch failed: ${response.status}`);
    }

    const body = (await response.json()) as BulkSnapshotResponse;
    const users = body.data?.users ?? [];
    const map = new Map<string, UserSnapshot>(users.map((u) => [u.userId, u]));

    for (const id of userIds) {
      if (!map.has(id)) {
        logger.warn(`User snapshot missing for userId=${id}, using fallback`);
        map.set(id, FALLBACK_SNAPSHOT(id));
      }
    }

    return map;
  } catch (error) {
    logger.error(
      "fetchUserSnapshots failed — using fallback for all requested users"
    );
    logger.error(error);
    return new Map(userIds.map((id) => [id, FALLBACK_SNAPSHOT(id)]));
  }
}

type FriendshipCheckResponse = {
  success: boolean;
  data?: { friends: string[] };
};

/**
 * Server-side friend validation. Returns the subset of `candidateIds` that are
 * ACCEPTED friends with the caller in user-service.
 *
 * Safety policy: on ANY failure (network, non-2xx, malformed body) return an
 * EMPTY set so callers reject all candidates as NOT_FRIEND. We prefer loud,
 * conservative failure over silent over-permissive adds.
 */
export async function fetchAcceptedFriendIds(
  callerId: string,
  candidateIds: string[]
): Promise<Set<string>> {
  if (candidateIds.length === 0) return new Set();

  const url =
    `${env.USER_SERVICE_URL.replace(/\/$/, "")}` +
    `/api/v1/users/internal/friendship-check` +
    `?callerId=${encodeURIComponent(callerId)}` +
    `&candidateIds=${candidateIds.join(",")}`;

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(env.USER_SERVICE_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Friendship check failed: ${response.status}`);
    }
    const body = (await response.json()) as FriendshipCheckResponse;
    return new Set(body.data?.friends ?? []);
  } catch (error) {
    logger.error(
      "fetchAcceptedFriendIds failed — treating all candidates as NOT_FRIEND"
    );
    logger.error(error);
    return new Set();
  }
}
