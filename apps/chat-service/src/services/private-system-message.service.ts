import { logger } from "@aimess/logger";
import type { Redis, Cluster } from "ioredis";

import type { SystemEvent } from "../types/enums.js";
import {
  buildChatMessageEvent,
  buildDeletePayload,
} from "../lib/chat-message.serializer.js";
import { publishConvUpdatedSafe } from "../events/publish-conv-updated.js";
import { systemMessageBumpsActivity } from "../lib/system-message-policy.js";
import type { PrivateMessageRepository } from "../repositories/private-message.repository.js";
import type { PrivateRoomRepository } from "../repositories/private-room.repository.js";
import type { UserSnapshotService } from "./user-snapshot.service.js";
import type { CacheRepository } from "../repositories/cache.repository.js";

export interface PostPrivateSystemMessageParams {
  roomId: string;
  actorId: string;
  peerId: string;
  systemEvent: SystemEvent;
  systemData?: Record<string, unknown>;
}

const TEXT_BY_EVENT: Record<string, (actorName: string) => string> = {
  MESSAGE_PINNED: (actor) => `${actor} pinned a message`,
  MESSAGE_UNPINNED: (actor) => `${actor} unpinned a message`,
};

/**
 * Posts SYSTEM messages for private-room lifecycle events (currently pin/unpin
 * — call lifecycle has its own `CallChatMessageService`). Mirrors
 * `GroupSystemMessageService`: persists a sender-less-in-spirit (but
 * attributed) `messageType: "SYSTEM"` row, bumps the room's denormalized
 * `lastMessage*` snapshot when the event type is bump-eligible
 * (`systemMessageBumpsActivity`), never increments unread, and fans out over
 * `conv:<roomId>` + `conv:updated`. Best-effort: failures are logged, never
 * thrown, so a pin/unpin never fails because its system message did.
 */
export class PrivateSystemMessageService {
  constructor(
    private readonly messageRepo: PrivateMessageRepository,
    private readonly roomRepo: PrivateRoomRepository,
    private readonly userSnapshotService: UserSnapshotService,
    private readonly cacheRepo: CacheRepository,
    private readonly redis: Redis | Cluster
  ) {}

  async post(params: PostPrivateSystemMessageParams): Promise<void> {
    await this.postOne(params);
  }

  /** Like post() but returns the created system message ID (or null on failure) — used by the pin flow to store a retractable back-reference. */
  async postReturnId(
    params: PostPrivateSystemMessageParams
  ): Promise<string | null> {
    return this.postOne(params);
  }

  private async postOne(
    params: PostPrivateSystemMessageParams
  ): Promise<string | null> {
    const { roomId, actorId, peerId, systemEvent } = params;
    try {
      const snapshots = await this.userSnapshotService.getUserSnapshotsMap(
        [actorId],
        this.cacheRepo
      );
      const actorSnap = (snapshots.get(actorId) || {}) as Record<
        string,
        unknown
      >;
      const actorName =
        (actorSnap.displayName as string) ||
        (actorSnap.username as string) ||
        "";
      const buildText = TEXT_BY_EVENT[systemEvent];
      const text = buildText ? buildText(actorName || "Someone") : "Updated";

      const systemData = { ...params.systemData, actorId, actorName };
      const sequenceNumber = await this.roomRepo.allocateSequence(roomId);
      const message = await this.messageRepo.createMessage({
        roomId,
        senderId: actorId,
        receiverId: peerId,
        messageType: "SYSTEM",
        systemEvent,
        systemData,
        countInUnread: false,
        content: { text, urls: [], files: [] },
        sequenceNumber,
      });

      const bumps = systemMessageBumpsActivity(systemEvent);
      if (bumps) {
        await this.roomRepo
          .updateRoomOnNewMessage({
            roomId,
            message: {
              _id: message.id,
              content: message.content,
              senderId: actorId,
              messageType: "SYSTEM",
              systemEvent,
              systemData,
              createdAt: message.createdAt,
            },
            receiverId: peerId,
            unreadIncrement: 0,
          })
          .catch((err: unknown) => {
            logger.warn(
              `PrivateSystemMessageService|room bump failed room=${roomId}: ${String(err)}`
            );
          });
      }

      const serverTs = message.createdAt.getTime();
      const wire = buildChatMessageEvent({
        id: message.id,
        roomId,
        conversationType: "PRIVATE",
        senderId: actorId,
        senderName: actorName,
        receiverId: peerId,
        messageType: "SYSTEM",
        content: message.content ?? { text, urls: [], files: [] },
        reactions: [],
        serverTs,
        sequenceNumber,
        systemEvent,
        systemData,
        countInUnread: false,
      });

      await this.redis
        .publish(
          `conv:${roomId}`,
          JSON.stringify({ event: "message:new", data: wire })
        )
        .catch((err: unknown) => {
          logger.warn(
            `PrivateSystemMessageService|publish failed room=${roomId}: ${String(err)}`
          );
        });

      if (bumps) {
        publishConvUpdatedSafe({
          redis: this.redis,
          type: "PRIVATE",
          roomId,
          recipientIds: [actorId, peerId],
          senderId: actorId,
          senderName: actorName,
          lastMessageId: message.id,
          lastMessageAt: serverTs,
          preview: { contentType: "SYSTEM", text },
          countInUnread: false,
        });
      }

      return message.id;
    } catch (err) {
      logger.warn(
        `PrivateSystemMessageService|post failed event=${systemEvent} room=${roomId}: ${String(err)}`
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
        actorId
      );
      const tombstone = buildDeletePayload({
        conversationType: "PRIVATE",
        messageId: deleted.id,
        roomId: deleted.roomId,
        scope: "forEveryone",
        deletedBy: actorId,
        sequenceNumber: deleted.sequenceNumber,
      });
      await this.redis.publish(
        `conv:${roomId}`,
        JSON.stringify({ event: "message:delete", data: tombstone })
      );
    } catch (err) {
      logger.warn(
        `PrivateSystemMessageService|retractSystemMessage failed messageId=${messageId}: ${String(err)}`
      );
    }
  }
}
