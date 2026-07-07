import { MEDIA_PREFIXES, toMediaObject } from "@aimess/storage";
import type { MediaObject } from "@aimess/shared-types";

import { recentSearchRepository } from "../repositories/recent-search.repository.js";
import { userProfileRepository } from "../repositories/user-profile.repository.js";
import { avatarService } from "./avatar.service.js";
import { env } from "../config/env.js";
import { mediaUrlStrategy } from "../config/storage.js";

export type RecentSearchEntry =
  | {
      id: string;
      type: "USER";
      user: {
        userId: string;
        username: string;
        firstName: string;
        lastName: string;
        bio: string | null;
        avatarUrl: string | null;
        avatarUrlExpiresIn: number | null;
        avatar: MediaObject;
        isOnline: boolean;
      };
      createdAt: Date;
    }
  | {
      id: string;
      type: "QUERY";
      query: string;
      createdAt: Date;
    };

async function resolveAvatar(stored: string | null) {
  const view = await avatarService.resolveViewUrlForClient(stored);
  const avatar = await toMediaObject({
    bucket: env.MINIO_BUCKET_AVATARS,
    stored,
    prefixes: MEDIA_PREFIXES.userAvatars,
    strategy: mediaUrlStrategy,
  });
  return { url: view?.url ?? null, expiresIn: view?.expiresIn ?? null, avatar };
}

export const recentSearchService = {
  async list(userId: string): Promise<RecentSearchEntry[]> {
    const rows = await recentSearchRepository.findByUserId(userId);

    // Batch-fetch profiles for user-type entries to avoid N+1
    const userIds = rows
      .map((r) => r.searchedUserId)
      .filter((id): id is string => id !== null);

    const profileMap = new Map<
      string,
      Awaited<ReturnType<typeof userProfileRepository.findByUserIds>>[number]
    >();
    if (userIds.length > 0) {
      const profiles = await userProfileRepository.findByUserIds(userIds);
      for (const p of profiles) profileMap.set(p.userId, p);
    }

    return Promise.all(
      rows.map(async (row): Promise<RecentSearchEntry> => {
        if (row.searchedUserId) {
          const profile = profileMap.get(row.searchedUserId);
          if (!profile) {
            // Profile deleted — treat as query-style fallback
            return {
              id: row.id,
              type: "QUERY" as const,
              query: row.searchedUserId,
              createdAt: row.createdAt,
            };
          }
          const { url, expiresIn, avatar } = await resolveAvatar(
            profile.avatarUrl
          );
          return {
            id: row.id,
            type: "USER" as const,
            user: {
              userId: profile.userId,
              username: profile.username,
              firstName: profile.firstName,
              lastName: profile.lastName,
              bio: null, // not available from findByUserIds select
              avatarUrl: url,
              avatarUrlExpiresIn: expiresIn,
              avatar,
              isOnline: profile.isOnline,
            },
            createdAt: row.createdAt,
          };
        }

        return {
          id: row.id,
          type: "QUERY" as const,
          query: row.query ?? "",
          createdAt: row.createdAt,
        };
      })
    );
  },

  async record(params: {
    userId: string;
    searchedUserId?: string;
    query?: string;
  }): Promise<void> {
    await recentSearchRepository.upsert(params);
  },

  async deleteOne(id: string, userId: string): Promise<boolean> {
    const result = await recentSearchRepository.deleteById(id, userId);
    return result.count > 0;
  },

  async clearAll(userId: string): Promise<void> {
    await recentSearchRepository.clearAll(userId);
  },
};
