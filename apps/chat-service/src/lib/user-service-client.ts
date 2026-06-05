import { logger } from "@aimess/logger";

import { userGrpcClient } from "../grpc/user-snapshot.client.js";
import { authGrpcClient } from "../grpc/auth.client.js";

export interface UserBatchEntry {
  userId: string;
  displayName: string;
  username: string;
  avatar: string;
  isOnline: boolean;
}

export async function fetchUsersBatch(
  userIds: string[]
): Promise<UserBatchEntry[]> {
  if (userIds.length === 0) return [];

  try {
    const users = await userGrpcClient.bulkGetUserSnapshots(userIds);
    return users.map((u) => ({
      userId: u.userId,
      displayName: u.displayName ?? "",
      username: u.username ?? "",
      avatar: u.avatarObjectKey ?? "",
      isOnline: false,
    }));
  } catch (err) {
    logger.warn(
      `userGrpcClient|bulkGetUserSnapshots error: ${err instanceof Error ? err.message : String(err)}`
    );
    return [];
  }
}

export async function fetchAccountsBatch(
  userIds: string[]
): Promise<Array<{ userId: string; account: string }>> {
  if (userIds.length === 0) return [];

  try {
    return await authGrpcClient.bulkGetAccounts(userIds);
  } catch (err) {
    logger.warn(
      `authGrpcClient|bulkGetAccounts error: ${err instanceof Error ? err.message : String(err)}`
    );
    return [];
  }
}
