import { filterBannedUserIds } from "@aimess/redis";

import { redis } from "../config/redis.js";

// Platform-banned subset of `userIds`, read off the ban key (authoritative and
// immediate — the profile-status mirror is fire-and-forget). Fails open, like
// every other ban read: a Redis blip must not empty people's friend lists.
export function bannedAmong(userIds: string[]): Promise<Set<string>> {
  return filterBannedUserIds(redis, userIds).catch(() => new Set<string>());
}
