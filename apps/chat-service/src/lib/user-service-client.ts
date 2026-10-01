import * as grpc from "@grpc/grpc-js";
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
 * gRPC NOT_FOUND is an ANSWER ("none of these ids exist"), not a failed lookup.
 * Reporting it as `null` would turn a permanently missing historical identity
 * into a retryable CHAT_IDENTITY_UNAVAILABLE that no retry can ever clear.
 * Every other status (UNAVAILABLE, DEADLINE_EXCEEDED, INTERNAL, UNAUTHENTICATED,
 * an open breaker, …) means we could not ask, and stays `null`.
 */
function isNotFound(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === grpc.status.NOT_FOUND;
}

/** `status=<gRPC status name>|<message>` — so the log says WHY, not just "error". */
function describeLookupError(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  const status = typeof code === "number" ? grpc.status[code] : code;
  return `status=${String(status ?? "n/a")}|${err instanceof Error ? err.message : String(err)}`;
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
      `userGrpcClient|bulkGetUserSnapshots error|${describeLookupError(err)}|ids=${userIds.length}`
    );
    return isNotFound(err) ? [] : null;
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
      `authGrpcClient|bulkGetAccounts error|${describeLookupError(err)}|ids=${userIds.length}`
    );
    return isNotFound(err) ? [] : null;
  }
}
