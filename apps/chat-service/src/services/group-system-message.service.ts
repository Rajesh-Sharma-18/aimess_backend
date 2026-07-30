import { logger } from "@aimess/logger";
import type { Redis, Cluster } from "ioredis";

import {
  buildGroupSystemFallbackText,
  resolveGroupSystemSubjectUserId,
  resolvePersonDisplayName,
} from "@aimess/constants";
import type { SystemEvent } from "../types/enums.js";
import {
  buildChatMessageEvent,
  buildDeletePayload,
} from "../lib/chat-message.serializer.js";
import { publishConvUpdatedSafe } from "../events/publish-conv-updated.js";
import { resolveMediaUrl } from "../lib/media-resolve.js";
import type { GroupMessageRepository } from "../repositories/group-message.repository.js";
import type { GroupRoomRepository } from "../repositories/group-room.repository.js";
import type { GroupMemberRepository } from "../repositories/group-member.repository.js";
import type { CacheRepository } from "../repositories/cache.repository.js";
import type { UserSnapshotService } from "./user-snapshot.service.js";
import { shouldCountInUnread } from "../lib/unread-count.js";
import { systemMessageBumpsActivity } from "../lib/system-message-policy.js";

export interface PostSystemMessageParams {
  roomId: string;
  /** User who triggered the event (null for a pure-system event). */
  actorId: string | null;
  systemEvent: SystemEvent;
  /** Event-specific fields (e.g. targetUserId, newRole, newName). */
  systemData?: Record<string, unknown>;
}

/**
 * Posts SYSTEM messages for group lifecycle events ("X created the group",
 * "X added Y", "X left", role/rename/avatar changes, …).
 *
 * Each post: persists a `messageType: "SYSTEM"` GroupMessage with a `systemEvent`
 * code + structured `systemData` (clients localize from these) plus an English
 * `content.text` fallback for previews; bumps the room's `lastMessageAt` +
 * `lastMessagePreview` so the group surfaces and sorts in the unified inbox; and
 * fans out over Redis `conv:<roomId>` as `message:new` (same shape as a real
 * send). It does NOT increment unread counts — lifecycle chatter shouldn't raise
 * badges. The whole operation is best-effort: failures are logged, never thrown,
 * so a lifecycle action never fails because its system message did.
 */
export class GroupSystemMessageService {
  constructor(
    private readonly messageRepo: GroupMessageRepository,
    private readonly roomRepo: GroupRoomRepository,
    private readonly memberRepo: GroupMemberRepository,
    private readonly cacheRepo: CacheRepository,
    private readonly userSnapshotService: UserSnapshotService,
    private readonly redis: Redis | Cluster
  ) {}

  async post(params: PostSystemMessageParams): Promise<void> {
    await this.postOne(params);
  }

  /** Like post() but returns the created system message ID (or null on failure) — used by the pin flow to store a retractable back-reference. */
  async postReturnId(params: PostSystemMessageParams): Promise<string | null> {
    return this.postOne(params);
  }

  private async postOne(
    params: PostSystemMessageParams
  ): Promise<string | null> {
    const { roomId, actorId, systemEvent } = params;
    const inData = params.systemData ?? {};
    const targetUserId =
      typeof inData.targetUserId === "string" ? inData.targetUserId : null;

    try {
      const ids = [actorId, targetUserId].filter((id): id is string =>
        Boolean(id)
      );
      const snapshots = ids.length
        ? await this.userSnapshotService.getUserSnapshotsMap(
            ids,
            this.cacheRepo
          )
        : new Map<string, Record<string, unknown>>();

      const actorName = this.nameOf(snapshots, actorId);
      const targetName = this.nameOf(snapshots, targetUserId);
      const actorAvatar = actorId
        ? ((snapshots.get(actorId)?.avatar as string) ?? "")
        : "";

      const text = buildGroupSystemFallbackText(systemEvent, {
        actorName,
        targetName,
        actorId,
        ...(targetUserId ? { targetUserId } : {}),
        ...inData,
      });

      // Resolved names are folded into systemData so clients can render without
      // a second lookup, while keeping the raw ids for navigation.
      const systemData: Record<string, unknown> = {
        ...inData,
        actorId,
        actorName,
        ...(targetUserId ? { targetUserId, targetName } : {}),
      };

      // Allocate the per-room monotonic sequence (same as a real send) so
      // lifecycle/system messages flow through chat:catchup (seq > sinceSeq)
      // on reconnect instead of defaulting to 0 — which both excluded them
      // from gap-fill and broke the monotonic guarantee (many rows at seq 0).
      const seq = await this.roomRepo.allocateSequence(roomId);

      const message = await this.messageRepo.create({
        roomId,
        senderId: actorId,
        senderName: actorName,
        senderAvatar: actorAvatar,
        messageType: "SYSTEM",
        systemEvent,
        systemData,
        content: { text, urls: [], files: [] },
        sequenceNumber: seq,
      });

      // Bump inbox order/preview (no unread increment) — gated per-subtype so
      // membership churn (join/left/removed) can't reorder the list, matching
      // Community's SYSTEM_MESSAGE_BUMPS_ACTIVITY.
      if (systemMessageBumpsActivity(systemEvent)) {
        await this.roomRepo.updateLastMessage(roomId, {
          _id: message.id,
          senderId: message.senderId ?? null,
          senderName: message.senderName,
          messageType: message.messageType,
          content: { text },
          createdAt: message.createdAt,
        });
      }

      if (
        shouldCountInUnread({
          messageType: message.messageType,
          systemEvent,
          explicit: (message as unknown as { countInUnread?: boolean | null })
            .countInUnread,
        })
      ) {
        this.memberRepo
          .incUnreadForRoom(roomId, actorId ?? "", 1)
          .catch((err: unknown) => {
            logger.warn(
              `GroupSystemMessageService|incUnreadForRoom failed room=${roomId}: ${String(err)}`
            );
          });
      }

      // Real-time fan-out (best-effort) — same channel/event AND canonical
      // ChatMessage shape as a real send (§1/§9), with the SYSTEM extras.
      const sysServerTs =
        message.createdAt instanceof Date
          ? message.createdAt.getTime()
          : Date.now();
      // Resolve the actor avatar key → download URL on the SERIALIZE-OUT
      // boundary only; the persisted senderAvatar above keeps the raw key.
      const actorAvatarUrl = await resolveMediaUrl(actorAvatar);

      // Inbox bump for every member — `message:new` above only reaches sockets
      // already joined to `conv:<roomId>`, which excludes anyone sitting on the
      // chats list. Community's system service does the same (§community-system
      // -message.service.ts publishCommunityUpdatedSafe). Gated the same as the
      // DB write above — a non-bumping event (member left/removed, unpin, …)
      // must not reorder the recipient's inbox either.
      if (systemMessageBumpsActivity(systemEvent)) {
        // The subject member's own list row should read "You were added" /
        // "Alex promoted you to admin" rather than the shared third-person
        // line — mirrors Community's subjectUserId/selfPreview personalization.
        const subjectUserId = resolveGroupSystemSubjectUserId(
          systemEvent,
          systemData
        );
        const selfPreview = subjectUserId
          ? buildGroupSystemFallbackText(systemEvent, systemData, subjectUserId)
          : undefined;

        publishConvUpdatedSafe({
          redis: this.redis,
          type: "GROUP",
          roomId,
          fetchRecipients: async () =>
            (
              await this.memberRepo.findActiveMembers(roomId, { limit: 500 })
            ).map((m) => m.userId),
          senderId: "",
          lastMessageId: message.id,
          lastMessageAt: sysServerTs,
          preview: { contentType: "SYSTEM", text },
          countInUnread: false,
          ...(subjectUserId && selfPreview
            ? { subjectUserId, selfPreview }
            : {}),
        });
      }

      this.redis
        .publish(
          `conv:${roomId}`,
          JSON.stringify({
            event: "message:new",
            data: buildChatMessageEvent({
              id: message.id,
              roomId,
              conversationType: "GROUP",
              senderId: actorId ?? "",
              senderName: actorName,
              senderAvatar: actorAvatarUrl,
              messageType: "SYSTEM",
              content: message.content ?? { text, urls: [], files: [] },
              reactions: [],
              serverTs: sysServerTs,
              sequenceNumber: seq,
              systemEvent,
              systemData,
              countInUnread: (
                message as unknown as {
                  countInUnread?: boolean | null;
                }
              ).countInUnread,
            }),
          })
        )
        .catch((err: unknown) => {
          logger.warn(
            `GroupSystemMessageService|publish failed room=${roomId}: ${String(err)}`
          );
        });
      return message.id;
    } catch (err) {
      logger.warn(
        `GroupSystemMessageService|post failed event=${systemEvent} room=${roomId}: ${String(err)}`
      );
      return null;
    }
  }

  /**
   * Hard-hides a system message this service previously posted — currently
   * only the MESSAGE_PINNED line tied to a pin that was since undone (unpinned,
   * or replaced by pinning a different message). Same tombstone mechanism as a
   * normal message delete-for-everyone; just triggered by pin lifecycle instead
   * of a user delete action. Mirrors `CommunitySystemMessageService.retractSystemMessage`.
   * Best-effort: never throws — the pin state change that triggered this must
   * not roll back on a failure here.
   */
  async retractSystemMessage(params: {
    roomId: string;
    messageId: string;
    actorId: string;
  }): Promise<void> {
    const { roomId, messageId, actorId } = params;
    try {
      const deleted = await this.messageRepo.deleteForEveryone(
        messageId,
        roomId,
        actorId,
        "ADMIN_DELETE"
      );
      if (!deleted) return;
      const tombstone = buildDeletePayload({
        conversationType: "GROUP",
        messageId: deleted.id,
        roomId: deleted.roomId,
        scope: "forEveryone",
        deletedBy: actorId,
        sequenceNumber: deleted.sequenceNumber,
        deletedType: "ADMIN_DELETE",
      });
      await this.redis.publish(
        `conv:${roomId}`,
        JSON.stringify({ event: "message:delete", data: tombstone })
      );
    } catch (err) {
      logger.warn(
        `GroupSystemMessageService|retractSystemMessage failed messageId=${messageId}: ${String(err)}`
      );
    }
  }

  private nameOf(
    snapshots: Map<string, Record<string, unknown>>,
    userId: string | null
  ): string {
    if (!userId) return "";
    return resolvePersonDisplayName(snapshots.get(userId));
  }
}
