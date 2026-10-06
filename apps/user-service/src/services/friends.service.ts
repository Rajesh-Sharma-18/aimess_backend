import { MEDIA_PREFIXES, toMediaObject } from "@aimess/storage";

import {
  friendsRepository,
  type FriendProfileRow,
} from "../repositories/friends.repository.js";
import { userSettingsRepository } from "../repositories/user-settings.repository.js";
import { bannedAmong } from "../lib/banned-users.js";
import { allocatedUsername } from "../lib/username.util.js";
import type {
  FriendListItem,
  FriendsListResult,
} from "../types/friends.types.js";
import { env } from "../config/env.js";
import { mediaUrlStrategy } from "../config/storage.js";
import { avatarService } from "./avatar.service.js";

/** Section header for the alphabetical friends list. */
function sectionFor(firstName: string): string {
  const first = firstName.trim().charAt(0).toUpperCase();
  return /^[A-Z]$/.test(first) ? first : "#";
}

async function toFriendListItem(
  row: FriendProfileRow,
  callAllowedSet: Set<string>
): Promise<FriendListItem> {
  const avatarView = await avatarService.resolveViewUrlForClient(row.avatarUrl);

  const avatar = await toMediaObject({
    bucket: env.MINIO_BUCKET_AVATARS,
    stored: row.avatarUrl,
    prefixes: MEDIA_PREFIXES.userAvatars,
    strategy: mediaUrlStrategy,
  });

  return {
    userId: row.userId,
    username: allocatedUsername(row),
    firstName: row.firstName,
    lastName: row.lastName,
    avatarUrl: avatarView?.url ?? null,
    avatar,
    section: sectionFor(row.firstName),
    isCallAllowed: callAllowedSet.has(row.userId),
  };
}

export const friendsService = {
  /**
   * Accepted friends minus platform-banned ones: the single definition of
   * "friends" behind both the friends list and the profile `friendsCount`.
   * A ban keeps the friendship row and only hides it here (off the Redis ban
   * key, so it is immediate), which is why an unban restores the friend — and
   * the count — with no write, and why repeated ban processing can never
   * decrement anything twice.
   */
  async activeFriendIds(me: string): Promise<string[]> {
    const acceptedIds = await friendsRepository.listAcceptedFriendIds(me);
    const banned = await bannedAmong(acceptedIds);
    return acceptedIds.filter((id) => !banned.has(id));
  },

  async listFriends(
    me: string,
    params: { search?: string; cursor?: string; limit: number }
  ): Promise<FriendsListResult> {
    const friendIds = await friendsService.activeFriendIds(me);

    // No accepted friends → empty list, not an error.
    if (friendIds.length === 0) {
      return { friends: [], nextCursor: null, totalCount: 0 };
    }

    const [rows, allowedIds] = await Promise.all([
      friendsRepository.listFriendProfiles({
        friendIds,
        search: params.search,
        limit: params.limit,
        cursor: params.cursor,
      }),
      userSettingsRepository.findCallAllowedIds(me),
    ]);

    const callAllowedSet = new Set(allowedIds);
    const hasMore = rows.length > params.limit;
    const page = hasMore ? rows.slice(0, params.limit) : rows;
    const nextCursor = hasMore ? (page[page.length - 1]?.userId ?? null) : null;

    const friends = await Promise.all(
      page.map((row) => toFriendListItem(row, callAllowedSet))
    );

    return { friends, nextCursor, totalCount: friendIds.length };
  },
};
