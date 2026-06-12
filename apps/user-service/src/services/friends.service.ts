import { MEDIA_PREFIXES, toMediaObject } from "@aimess/storage";

import {
  friendsRepository,
  type FriendProfileRow,
} from "../repositories/friends.repository.js";
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
  row: FriendProfileRow
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
    username: row.username,
    firstName: row.firstName,
    lastName: row.lastName,
    avatarUrl: avatarView?.url ?? null,
    avatar,
    section: sectionFor(row.firstName),
  };
}

export const friendsService = {
  async listFriends(
    me: string,
    params: { search?: string; cursor?: string; limit: number }
  ): Promise<FriendsListResult> {
    const friendIds = await friendsRepository.listAcceptedFriendIds(me);

    // No accepted friends → empty list, not an error.
    if (friendIds.length === 0) {
      return { friends: [], nextCursor: null, totalCount: 0 };
    }

    const rows = await friendsRepository.listFriendProfiles({
      friendIds,
      search: params.search,
      limit: params.limit,
      cursor: params.cursor,
    });

    const hasMore = rows.length > params.limit;
    const page = hasMore ? rows.slice(0, params.limit) : rows;
    const nextCursor = hasMore ? (page[page.length - 1]?.userId ?? null) : null;

    const friends = await Promise.all(page.map(toFriendListItem));

    return { friends, nextCursor, totalCount: friendIds.length };
  },
};
