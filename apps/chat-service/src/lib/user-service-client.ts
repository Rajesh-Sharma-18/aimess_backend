import { logger } from "@aimess/logger";

import { env } from "../config/env.js";

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
  const baseUrl = env.USER_SERVICE_URL;
  if (!baseUrl) {
    logger.warn(
      "userServiceClient|USER_SERVICE_URL not configured, skipping batch fetch"
    );
    return [];
  }

  const url = `${baseUrl.replace(/\/$/, "")}/api/internal/users/batch`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userIds }),
      signal: AbortSignal.timeout(3000),
    });

    if (!res.ok) {
      logger.warn(`userServiceClient|batch fetch failed status=${res.status}`);
      return [];
    }

    const body = (await res.json()) as {
      success: boolean;
      data?: UserBatchEntry[];
    };
    return body.data ?? [];
  } catch (err) {
    logger.warn(
      `userServiceClient|batch fetch error: ${err instanceof Error ? err.message : String(err)}`
    );
    return [];
  }
}
