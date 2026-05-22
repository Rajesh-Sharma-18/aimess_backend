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
