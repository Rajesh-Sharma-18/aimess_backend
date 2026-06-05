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

export async function fetchUserSnapshots(
  userIds: string[]
): Promise<Map<string, UserSnapshot>> {
  if (userIds.length === 0) return new Map();

  try {
    const users = await userGrpcClient.bulkGetUserSnapshots(userIds);
    const map = new Map<string, UserSnapshot>(
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

    for (const id of userIds) {
      if (!map.has(id)) {
        logger.warn(`User snapshot missing for userId=${id}, using fallback`);
        map.set(id, FALLBACK_SNAPSHOT(id));
      }
    }

    return map;
  } catch (error) {
    logger.error(
      "fetchUserSnapshots (gRPC) failed — using fallback for all requested users"
    );
    logger.error(error);
    return new Map(userIds.map((id) => [id, FALLBACK_SNAPSHOT(id)]));
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
