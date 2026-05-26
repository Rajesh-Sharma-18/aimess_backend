import { logger } from "@aimess/logger";

import { env } from "../config/env.js";

export interface UserBatchEntry {
  userId: string;
  displayName: string;
  username: string;
  avatar: string;
  isOnline: boolean;
}

/**
 * Fetch user snapshots from user-service.
 * Returns displayName, username (= account), and avatar for each userId.
 */
export async function fetchUsersBatch(
  userIds: string[]
): Promise<UserBatchEntry[]> {
  const baseUrl = env.USER_SERVICE_URL;
  if (!baseUrl) {
    logger.warn(
      "userServiceClient|USER_SERVICE_URL not configured, skipping batch fetch"
    );
    return [];
  }

  // user-service: GET /api/internal/bulk-snapshot?userIds=id1,id2,...
  const qs = userIds.join(",");
  const url = `${baseUrl.replace(/\/$/, "")}/api/internal/bulk-snapshot?userIds=${encodeURIComponent(qs)}`;

  try {
    const res = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(3000),
    });

    if (!res.ok) {
      logger.warn(
        `userServiceClient|bulk-snapshot failed status=${res.status}`
      );
      return [];
    }

    // Response: { success, data: { users: [{ userId, username, displayName, avatarObjectKey }] } }
    const body = (await res.json()) as {
      success: boolean;
      data?: {
        users?: Array<{
          userId: string;
          username: string;
          displayName: string;
          avatarObjectKey: string | null;
        }>;
      };
    };

    return (body.data?.users ?? []).map((u) => ({
      userId: u.userId,
      displayName: u.displayName ?? "",
      username: u.username ?? "",
      avatar: u.avatarObjectKey ?? "",
      isOnline: false,
    }));
  } catch (err) {
    logger.warn(
      `userServiceClient|bulk-snapshot error: ${err instanceof Error ? err.message : String(err)}`
    );
    return [];
  }
}

/**
 * Fallback: fetch account names directly from auth-service.
 * Used when user-service has no profile for a user yet
 * (e.g. user.registered event not yet consumed).
 * Returns { userId, account } — `account` becomes the senderName.
 */
export async function fetchAccountsBatch(
  userIds: string[]
): Promise<Array<{ userId: string; account: string }>> {
  const baseUrl = env.AUTH_SERVICE_URL;
  if (!baseUrl) return [];

  const qs = userIds.join(",");
  const url = `${baseUrl.replace(/\/$/, "")}/api/internal/accounts?userIds=${encodeURIComponent(qs)}`;

  try {
    const res = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(3000),
    });

    if (!res.ok) {
      logger.warn(`authServiceClient|accounts failed status=${res.status}`);
      return [];
    }

    const body = (await res.json()) as {
      success: boolean;
      data?: { accounts?: Array<{ userId: string; account: string }> };
    };

    return body.data?.accounts ?? [];
  } catch (err) {
    logger.warn(
      `authServiceClient|accounts error: ${err instanceof Error ? err.message : String(err)}`
    );
    return [];
  }
}
