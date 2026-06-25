import { logger } from "@aimess/logger";

import { userGrpcClient } from "../grpc/user.client.js";

export type UserSnapshot = {
  userId: string;
  username: string;
  displayName: string;
  avatarObjectKey: string | null;
};

const FALLBACK_SNAPSHOT = (userId: string): UserSnapshot => ({
  userId,
  username: userId,
  displayName: "Unknown",
  avatarObjectKey: null,
});

/**
 * Returns a map of ONLY the users user-service actually resolved — no
 * `"Unknown"` placeholder back-fill. A userId absent from the returned map was
 * not resolved, either because the profile is genuinely gone OR because
 * user-service was unavailable (gRPC error / breaker open → empty map).
 *
 * Read paths that already hold a denormalized snapshot (e.g. the community
 * member list, whose membership docs persist last-known-good name/avatar) MUST
 * use this instead of {@link fetchUserSnapshots}: a transient user-service
 * hiccup then leaves the stored snapshot intact rather than clobbering every
 * member's real name with the `"Unknown"` placeholder.
 */
export async function fetchUserSnapshotHits(
  userIds: string[]
): Promise<Map<string, UserSnapshot>> {
  if (userIds.length === 0) return new Map();

  try {
    const users = await userGrpcClient.bulkGetUserSnapshots(userIds);
    return new Map<string, UserSnapshot>(
      users.map((u) => [
        u.userId,
        {
          userId: u.userId,
          username: u.username,
          displayName: u.displayName,
          avatarObjectKey: u.avatarObjectKey === "" ? null : u.avatarObjectKey,
        },
      ])
    );
  } catch (error) {
    logger.error(
      "fetchUserSnapshotHits (gRPC) failed — caller will fall back to stored data"
    );
    logger.error(error);
    return new Map();
  }
}

export async function fetchUserSnapshots(
  userIds: string[]
): Promise<Map<string, UserSnapshot>> {
  if (userIds.length === 0) return new Map();

  // Resolve the real hits, then back-fill a placeholder for any id user-service
  // did not return so callers WITHOUT a stored snapshot always get a name.
  const map = await fetchUserSnapshotHits(userIds);
  for (const id of userIds) {
    if (!map.has(id)) {
      logger.warn(`User snapshot missing for userId=${id}, using fallback`);
      map.set(id, FALLBACK_SNAPSHOT(id));
    }
  }
  return map;
}

/**
 * Returns the subset of `userIds` that correspond to REAL existing users in
 * user-service. Unlike {@link fetchUserSnapshots} (which back-fills a placeholder
 * snapshot for every requested id so callers always get a name), this preserves
 * the gap: an id absent from the result simply does not exist. Use it to validate
 * recipients before fanning out.
 *
 * Returns `null` when the user-service lookup is UNAVAILABLE (gRPC error / breaker
 * open) — distinct from "exists but empty" — so callers can decide whether to
 * fail-open or fail-closed rather than mistaking an outage for "no users exist".
 */
export async function fetchExistingUserIds(
  userIds: string[]
): Promise<Set<string> | null> {
  if (userIds.length === 0) return new Set();

  try {
    const users = await userGrpcClient.bulkGetUserSnapshots(userIds);
    return new Set(users.map((u) => u.userId));
  } catch (error) {
    logger.error(
      "fetchExistingUserIds (gRPC) failed — user existence could not be verified"
    );
    logger.error(error);
    return null;
  }
}

export async function fetchAcceptedFriendIds(
  callerId: string,
  candidateIds: string[]
): Promise<Set<string>> {
  if (candidateIds.length === 0) return new Set();

  try {
    const friendIds = await userGrpcClient.checkFriendships(
      callerId,
      candidateIds
    );
    return new Set(friendIds);
  } catch (error) {
    logger.error(
      "fetchAcceptedFriendIds (gRPC) failed — treating all candidates as NOT_FRIEND"
    );
    logger.error(error);
    return new Set();
  }
}
