import { logger } from "@aimess/logger";
import type { Redis, Cluster } from "ioredis";

import {
  type CommunitySystemMessageType,
  type CommunitySystemMessageVisibility,
} from "@aimess/constants";
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
  /**
   * Visibility scope: PERSONAL messages (e.g., "You joined") are only visible
   * to a specific user; COMMUNITY messages are visible to all members.
   * Defaults to COMMUNITY for backwards compatibility.
   */
  visibilityType?: CommunitySystemMessageVisibility;
  /**
   * For PERSONAL messages, the userId who should see this message.
   * Required when visibilityType === "PERSONAL".
   */
  visibleToUserId?: string;
}

/**
 * Posts SYSTEM messages for community lifecycle events.
 *
 * Telegram-style rules:
 * - COMMUNITY_CREATED  → one message ("John created the community")
 * - COMMUNITY_UPDATED  → one message PER changed field ("John changed the community photo")
 * - MEMBER_ROLE_CHANGED → one message ("John promoted Jane to Moderator")
 *
 * All metadata carries `actorUserId` so the frontend can compare against the
 * logged-in user and render "You" vs the actor's display name — the backend
 * never stores "You".
 *
 * Posts are best-effort: failures are logged, never thrown.
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
    // For COMMUNITY_UPDATED: emit one system message per changed field (Telegram-style).
    // Each message carries changedFields with exactly one item so the frontend
    // can produce a precise label ("changed the community photo", etc.).
    if (params.systemMessageType === "COMMUNITY_UPDATED") {
      const fields = Array.isArray(params.metadata.changedFields)
        ? (params.metadata.changedFields as string[])
        : [];
      if (fields.length > 1) {
        for (const field of fields) {
          await this.postOne({
            ...params,
            metadata: { ...params.metadata, changedFields: [field] },
          });
        }
        return;
      }
    }
    await this.postOne(params);
  }

  private async postOne(
    params: PostCommunitySystemMessageParams
  ): Promise<void> {
    const {
      communityId,
      systemMessageType,
      metadata,
      triggeredByUserId,
      visibilityType = "COMMUNITY",
      visibleToUserId,
    } = params;

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

      // Build enriched metadata with resolved names. actorUserId is the single
      // consistent key across all system message types so the frontend can always
      // do `metadata.actorUserId === currentUserId` to decide "You" vs actorName.
      const enrichedMetadata: Record<string, unknown> = {
        ...metadata,
        actorUserId: triggeredByUserId,
        actorName,
        ...(targetUserId ? { targetName } : {}),
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
        // PERSONAL messages are persisted with the target user so history reads
        // only return them to that user (the join "You joined" message).
        visibleToUserId:
          visibilityType === "PERSONAL" ? (visibleToUserId ?? null) : null,
      });

      // Bump inbox ordering (no unread increment — system messages don't badge).
      // Skip for PERSONAL messages since they're not visible to all members.
      if (visibilityType === "COMMUNITY") {
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
      }

      const serverTs =
        message.createdAt instanceof Date
          ? message.createdAt.getTime()
          : Date.now();
      const actorAvatarUrl = await resolveMediaUrl(actorAvatar);

      // Real-time fan-out — mirrors the orchestrator community wire shape with
      // SYSTEM extras. systemMetadata always carries actorUserId so clients can
      // render "You" vs actor name without an additional fetch.
      //
      // For PERSONAL messages (e.g., "You joined"), emit to the user's personal
      // channel instead of the room so only they see it.
      const redisChannel =
        visibilityType === "PERSONAL" && visibleToUserId
          ? `user:${visibleToUserId}`
          : `community:${communityId}`;

      this.redis
        .publish(
          redisChannel,
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
              systemMessageType,
              systemMetadata: enrichedMetadata,
            },
          })
        )
        .catch((err: unknown) => {
          logger.warn(
            `CommunitySystemMessageService|redis.publish failed channel=${redisChannel}: ${String(err)}`
          );
        });

      // Only publish activity for COMMUNITY messages (visible to all).
      // PERSONAL messages don't affect the community's last activity.
      if (visibilityType === "COMMUNITY") {
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
      }
    } catch (err) {
      logger.warn(
        `CommunitySystemMessageService|postOne failed type=${systemMessageType} communityId=${communityId}: ${String(err)}`
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

/**
 * Maps the stored `changedFields` token to a human-readable label used in the
 * English fallback text (and as a hint to the frontend).
 */
const FIELD_LABEL: Record<string, string> = {
  avatar: "community photo",
  name: "community title",
  description: "community description",
  visibility: "community visibility",
  handle: "community link",
  category: "community category",
  rules: "community rules",
  banner: "community banner",
};

/**
 * Returns a numeric rank for role comparison so we can say "promoted" vs
 * "demoted" without hardcoding string comparisons.
 */
function roleRank(role: string): number {
  if (role === "ADMIN") return 2;
  if (role === "MODERATOR") return 1;
  return 0; // MEMBER or unknown
}

/** "MODERATOR" → "Moderator" */
function formatRole(role: string): string {
  if (!role) return role;
  return role.charAt(0).toUpperCase() + role.slice(1).toLowerCase();
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
        ? (metadata.changedFields as string[])
        : [];
      // changedFields always has one item here (multi-field callers loop via post()).
      if (fields.length === 1) {
        const label = FIELD_LABEL[fields[0]] ?? `community ${fields[0]}`;
        return `${actor} changed the ${label}`;
      }
      return `${actor} updated the community`;
    }

    case "MEMBER_ROLE_CHANGED": {
      const target =
        (metadata.targetName as string) || targetName || "a member";
      const newRole = (metadata.newRole as string) || "";
      const oldRole = (metadata.oldRole as string) || "";
      const verb =
        roleRank(newRole) > roleRank(oldRole) ? "promoted" : "demoted";
      return `${actor} ${verb} ${target} to ${formatRole(newRole)}`;
    }

    case "COMMUNITY_JOINED":
      return "You joined this community";

    default:
      return `${actor} updated the community`;
  }
}
