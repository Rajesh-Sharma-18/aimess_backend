import { logger } from "@aimess/logger";
import type { Redis, Cluster } from "ioredis";

import { type CommunitySystemMessageType } from "@aimess/constants";
import { normalizeMessageType } from "../lib/chat-message.serializer.js";
import { resolveMediaUrl } from "../lib/media-resolve.js";
import type { GeneralRoomMessageRepository } from "../repositories/general-room-message.repository.js";
import type { GeneralRoomRepository } from "../repositories/general-room.repository.js";
import type { CacheRepository } from "../repositories/cache.repository.js";
import type { UserSnapshotService } from "./user-snapshot.service.js";
import { publishCommunityActivitySafe } from "../events/publish-community-activity.js";

export interface PostCommunitySystemMessageParams {
  communityId: string;
  systemMessageType: CommunitySystemMessageType;
  metadata: Record<string, unknown>;
  triggeredByUserId: string;
}

/**
 * Posts SYSTEM messages for community lifecycle events ("X created the community",
 * "X updated the community", "X changed Y's role to Z").
 *
 * Each post: persists a `messageType: "SYSTEM"` GeneralRoomMessage with
 * `systemMessageType` + `systemMetadata` (clients localize from these) plus an
 * English `message` fallback for previews; bumps the room's `lastMessageAt` so
 * the community sorts in the unified inbox; and fans out over Redis
 * `community:<communityId>` as `community:message:new` (same canonical shape as
 * a real send). It does NOT increment unread counts — lifecycle chatter shouldn't
 * raise badges. The whole operation is best-effort: failures are logged, never
 * thrown, so a lifecycle action never fails because its system message did.
 */
export class CommunitySystemMessageService {
  constructor(
    private readonly messageRepo: GeneralRoomMessageRepository,
    private readonly roomRepo: GeneralRoomRepository,
    private readonly cacheRepo: CacheRepository,
    private readonly userSnapshotService: UserSnapshotService,
    private readonly redis: Redis | Cluster
  ) {}

  async post(params: PostCommunitySystemMessageParams): Promise<void> {
    const { communityId, systemMessageType, metadata, triggeredByUserId } =
      params;

    try {
      const targetUserId =
        typeof metadata.targetUserId === "string"
          ? metadata.targetUserId
          : null;
      const ids = [triggeredByUserId, targetUserId].filter((id): id is string =>
        Boolean(id)
      );
      const snapshots = ids.length
        ? await this.userSnapshotService.getUserSnapshotsMap(
            ids,
            this.cacheRepo
          )
        : new Map<string, Record<string, unknown>>();

      const actorName = this.nameOf(snapshots, triggeredByUserId);
      const targetName = this.nameOf(snapshots, targetUserId);
      const actorAvatar =
        (snapshots.get(triggeredByUserId)?.avatar as string) ?? "";

      // Fold resolved names into metadata so client can render without extra fetch.
      const enrichedMetadata: Record<string, unknown> = {
        ...metadata,
        ...(systemMessageType === "COMMUNITY_CREATED"
          ? { creatorName: actorName }
          : {}),
        ...(systemMessageType === "COMMUNITY_UPDATED"
          ? { updaterName: actorName }
          : {}),
        ...(systemMessageType === "MEMBER_ROLE_CHANGED"
          ? { actorName, ...(targetUserId ? { targetName } : {}) }
          : {}),
      };

      const fallbackText = buildFallbackText(
        systemMessageType,
        enrichedMetadata,
        actorName,
        targetName
      );
      const seq = await this.roomRepo.allocateSequence(communityId);

      const message = await this.messageRepo.createSystemMessage({
        roomId: communityId,
        systemMessageType,
        metadata: enrichedMetadata,
        triggeredByUserId,
        triggeredByName: actorName,
        sequenceNumber: seq,
        fallbackText,
      });

      // Bump inbox ordering (no unread increment — system messages don't badge).
      this.roomRepo
        .addLastestMessageToRoom(communityId, {
          _id: message.id,
          sentBy: message.sentBy,
          senderName: message.senderName ?? "",
          message: message.message ?? "",
          messageType: message.messageType,
          createdAt: message.createdAt,
        })
        .catch((err: unknown) => {
          logger.warn(
            `CommunitySystemMessageService|addLastestMessageToRoom failed: ${String(err)}`
          );
        });

      const serverTs =
        message.createdAt instanceof Date
          ? message.createdAt.getTime()
          : Date.now();
      const actorAvatarUrl = await resolveMediaUrl(actorAvatar);

      // Real-time fan-out (best-effort) — mirrors the orchestrator community
      // wire shape (communityId + roomId, no conversationType) with SYSTEM extras.
      this.redis
        .publish(
          `community:${communityId}`,
          JSON.stringify({
            event: "community:message:new",
            data: {
              id: message.id,
              messageId: message.id,
              communityId,
              roomId: communityId,
              senderId: triggeredByUserId,
              senderName: actorName,
              senderAvatar: actorAvatarUrl,
              parentMessageId: "",
              quoteData: null,
              content: { text: fallbackText, files: [] },
              reactions: [],
              message: fallbackText,
              contentType: normalizeMessageType("SYSTEM"),
              clientMessageId: "",
              serverTs,
              sentAt: serverTs,
              sequenceNumber: seq,
              // Community lifecycle system message extras.
              systemMessageType,
              systemMetadata: enrichedMetadata,
            },
          })
        )
        .catch((err: unknown) => {
          logger.warn(
            `CommunitySystemMessageService|redis.publish failed communityId=${communityId}: ${String(err)}`
          );
        });

      publishCommunityActivitySafe({
        communityId,
        lastMessageAt:
          message.createdAt instanceof Date
            ? message.createdAt.toISOString()
            : new Date(serverTs).toISOString(),
        lastMessageId: message.id,
        senderUserId: triggeredByUserId,
        senderUsername: actorName,
        messagePreview:
          fallbackText.length > 80 ? fallbackText.slice(0, 80) : fallbackText,
        type: "system",
      });
    } catch (err) {
      logger.warn(
        `CommunitySystemMessageService|post failed type=${systemMessageType} communityId=${communityId}: ${String(err)}`
      );
    }
  }

  private nameOf(
    snapshots: Map<string, Record<string, unknown>>,
    userId: string | null
  ): string {
    if (!userId) return "";
    const snap = snapshots.get(userId);
    if (!snap) return "";
    return (snap.displayName as string) || (snap.username as string) || "";
  }
}

function buildFallbackText(
  type: CommunitySystemMessageType,
  metadata: Record<string, unknown>,
  actorName: string,
  targetName: string
): string {
  const actor = actorName || "Someone";
  switch (type) {
    case "COMMUNITY_CREATED":
      return `${actor} created the community`;
    case "COMMUNITY_UPDATED": {
      const fields = Array.isArray(metadata.changedFields)
        ? (metadata.changedFields as string[]).join(", ")
        : "";
      return fields
        ? `${actor} updated the community (${fields})`
        : `${actor} updated the community`;
    }
    case "MEMBER_ROLE_CHANGED": {
      const target =
        (metadata.targetName as string) || targetName || "a member";
      const newRole = (metadata.newRole as string) || "";
      return `${actor} changed ${target}'s role to ${newRole}`;
    }
    default:
      return `${actor} updated the community`;
  }
}
