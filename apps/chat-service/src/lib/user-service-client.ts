import { logger } from "@aimess/logger";

import { userGrpcClient } from "../grpc/user-snapshot.client.js";
import { authGrpcClient } from "../grpc/auth.client.js";

export interface UserBatchEntry {
  userId: string;
  displayName: string;
  username: string;
  avatar: string;
  isOnline: boolean;
  /** Account deleted — identity already anonymized by user-service. */
  isDeleted: boolean;
}

/**
 * `null` means the LOOKUP FAILED (transport error, open circuit breaker); `[]`
 * means the lookup succeeded and the service holds none of these ids.
 *
 * The two used to collapse into `[]`, and that is what let a transient blip be
 * serialized as a permanent answer: the caller could not tell "this user does
 * not exist" from "I could not ask", so it fell through to the
 * `resolveDisplayName` placeholder and shipped "Unknown User" on a conversation
 * row whose peer is perfectly real. See `UserSnapshotService.getUserSnapshotsMap`.
 */
export async function fetchUsersBatch(
  userIds: string[]
): Promise<UserBatchEntry[] | null> {
  if (userIds.length === 0) return [];

  try {
    const users = await userGrpcClient.bulkGetUserSnapshots(userIds);
    return users.map((u) => ({
      userId: u.userId,
      displayName: u.displayName ?? "",
      username: u.username ?? "",
      avatar: u.avatarObjectKey ?? "",
      isOnline: false,
      isDeleted: u.isDeleted === true,
    }));
  } catch (err) {
    logger.warn(
      `userGrpcClient|bulkGetUserSnapshots error: ${err instanceof Error ? err.message : String(err)}|ids=${userIds.length}`
    );
    return null;
  }
}

/** Same `null` = lookup failed / `[]` = nothing found contract as {@link fetchUsersBatch}. */
export async function fetchAccountsBatch(
  userIds: string[]
): Promise<Array<{ userId: string; account: string }> | null> {
  if (userIds.length === 0) return [];

  try {
    return await authGrpcClient.bulkGetAccounts(userIds);
  } catch (err) {
    logger.warn(
      `authGrpcClient|bulkGetAccounts error: ${err instanceof Error ? err.message : String(err)}|ids=${userIds.length}`
    );
    return null;
  }
}
