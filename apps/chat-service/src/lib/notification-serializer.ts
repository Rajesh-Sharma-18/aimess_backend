import type { Notification } from "../generated/prisma/index.js";

import { categorize } from "./notification-category.js";
import {
  resolveNotificationFriendship,
  type NotificationFriendshipDTO,
} from "./notification-friendship.enricher.js";

/**
 * Notification response DTO shared by REST + gRPC list paths.
 *
 * Avatars: `actor.avatar` and `community.avatar` are read directly from
 * fields the producer already writes into `payload.data` (see the
 * `actorSnapshot` / `communityAvatarUrl` fields set in every
 * `notifications-service` consumer). No extra media round-trip — same
 * values the producer chose, just surfaced onto the response instead of
 * buried inside the raw payload blob.
 */
export interface NotificationDTO {
  id: string;
  type: string;
  category: "FRIENDS" | "COMMUNITIES" | "MENTIONS" | "SYSTEM";
  title: string;
  body: string;
  isRead: boolean;
  createdAt: Date;
  /** Kept for backward compatibility with clients that dug into it. */
  payload: Record<string, unknown>;
  actor?: {
    id: string;
    displayName: string;
    avatar: { url: string } | null;
  };
  community?: {
    id: string;
    name: string;
    handle?: string;
    avatar: { url: string } | null;
  };
  navigation?: unknown;
  referenceId?: string;
  friendship?: NotificationFriendshipDTO;
}

function parseJson(raw: unknown): unknown {
  if (typeof raw !== "string" || !raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function nonEmpty(s: unknown): string | undefined {
  return typeof s === "string" && s.length > 0 ? s : undefined;
}

/**
 * Freshly-resolved actor/community avatars, keyed by id, built once per page
 * by `resolveAvatarRefresh` (notification.service.ts) and threaded through to
 * every row. Takes priority over anything stored in `payload.data` — the
 * stored value is a presigned URL snapshot from publish time and may have
 * expired by the time the row is read.
 */
export interface AvatarRefreshMaps {
  actorById: Map<string, { displayName: string; avatarUrl: string }>;
  communityById: Map<string, { name: string; avatarUrl: string }>;
}

const EMPTY_REFRESH: AvatarRefreshMaps = {
  actorById: new Map(),
  communityById: new Map(),
};

/**
 * One-shot Notification row → response DTO. Reuses the existing
 * `resolveNotificationFriendship` enricher (friend actionability) — no new
 * gRPC calls beyond the batched avatar refresh already done by the caller.
 * Pass a viewerId; friendship enrichment is viewer-relative.
 */
export async function serializeNotification(
  row: Notification,
  viewerId: string,
  refresh: AvatarRefreshMaps = EMPTY_REFRESH
): Promise<NotificationDTO> {
  const payloadObj = (row.payload ?? {}) as {
    title?: string;
    body?: string;
    data?: Record<string, string>;
  };
  const data = payloadObj.data ?? {};
  const entity = (row.entity ?? {}) as { id?: string };

  const navigation = parseJson(data.navigation);
  const actorSnapshot = parseJson(data.actorSnapshot) as
    | { userId?: string; displayName?: string; avatarUrl?: string }
    | undefined;

  const actorId = row.actorId || actorSnapshot?.userId || "";
  const freshActor = actorId ? refresh.actorById.get(actorId) : undefined;
  const actorAvatarUrl = nonEmpty(
    freshActor?.avatarUrl ??
      actorSnapshot?.avatarUrl ??
      data.requesterAvatarUrl ??
      data.actorAvatarUrl
  );
  const actorDisplayName =
    freshActor?.displayName ||
    actorSnapshot?.displayName ||
    data.requesterDisplayName ||
    data.actorDisplayName ||
    "";
  const actor = actorId
    ? {
        id: actorId,
        displayName: actorDisplayName,
        avatar: actorAvatarUrl ? { url: actorAvatarUrl } : null,
      }
    : undefined;

  const communityId = nonEmpty(data.communityId);
  const freshCommunity = communityId
    ? refresh.communityById.get(communityId)
    : undefined;
  const community = communityId
    ? {
        id: communityId,
        name: freshCommunity?.name || data.communityName || "",
        handle: nonEmpty(data.communityHandle),
        avatar: nonEmpty(freshCommunity?.avatarUrl ?? data.communityAvatarUrl)
          ? {
              url: (freshCommunity?.avatarUrl ??
                data.communityAvatarUrl) as string,
            }
          : null,
      }
    : undefined;

  const friendship = await resolveNotificationFriendship(
    viewerId,
    row.type,
    data.friendshipId
  );

  return {
    id: row.id,
    type: row.type,
    category: categorize(row.type),
    title: payloadObj.title ?? "",
    body: payloadObj.body ?? "",
    isRead: row.isRead,
    createdAt: row.createdAt,
    payload: payloadObj as Record<string, unknown>,
    ...(actor ? { actor } : {}),
    ...(community ? { community } : {}),
    ...(navigation !== undefined ? { navigation } : {}),
    ...(entity.id ? { referenceId: entity.id } : {}),
    ...(friendship ? { friendship } : {}),
  };
}
