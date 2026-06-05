import { logger } from "@aimess/logger";
import type { Redis, Cluster } from "ioredis";

import { SystemEvent } from "../types/enums.js";
import type { GroupMessageRepository } from "../repositories/group-message.repository.js";
import type { GroupRoomRepository } from "../repositories/group-room.repository.js";
import type { CacheRepository } from "../repositories/cache.repository.js";
import type { UserSnapshotService } from "./user-snapshot.service.js";

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
    private readonly cacheRepo: CacheRepository,
    private readonly userSnapshotService: UserSnapshotService,
    private readonly redis: Redis | Cluster
  ) {}

  async post(params: PostSystemMessageParams): Promise<void> {
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

      const text = buildSystemText(systemEvent, {
        actorName,
        targetName,
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

      // Bump inbox order/preview (no unread increment).
      await this.roomRepo.updateLastMessage(roomId, {
        _id: message.id,
        senderId: message.senderId ?? null,
        senderName: message.senderName,
        messageType: message.messageType,
        content: { text },
        createdAt: message.createdAt,
      });

      // Real-time fan-out (best-effort) — same channel/event as a real send.
      this.redis
        .publish(
          `conv:${roomId}`,
          JSON.stringify({
            event: "message:new",
            data: {
              messageId: message.id,
              conversationId: roomId,
              senderId: actorId,
              contentType: "SYSTEM",
              contentText: text,
              contentJson: JSON.stringify(message.content),
              sequenceNumber: seq,
              systemEvent,
              systemData,
              sentAt:
                message.createdAt instanceof Date
                  ? message.createdAt.getTime()
                  : Date.now(),
            },
          })
        )
        .catch((err: unknown) => {
          logger.warn(
            `GroupSystemMessageService|publish failed room=${roomId}: ${String(err)}`
          );
        });
    } catch (err) {
      logger.warn(
        `GroupSystemMessageService|post failed event=${systemEvent} room=${roomId}: ${String(err)}`
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
    return (snap.displayName as string) || (snap.memberId as string) || "";
  }
}

/**
 * English fallback text per system event, used for inbox/notification previews.
 * Clients should prefer rendering from `systemEvent` + `systemData` for i18n.
 */
function buildSystemText(
  event: SystemEvent,
  data: Record<string, unknown>
): string {
  const actor = (data.actorName as string) || "Someone";
  const target = (data.targetName as string) || "a member";
  switch (event) {
    case SystemEvent.GROUP_CREATED:
      return `${actor} created the group`;
    case SystemEvent.MEMBER_ADDED:
      return `${actor} added ${target}`;
    case SystemEvent.MEMBER_JOINED:
      return `${actor} joined the group`;
    case SystemEvent.MEMBER_LEFT:
      return `${actor} left the group`;
    case SystemEvent.MEMBER_REMOVED:
      return `${actor} removed ${target}`;
    case SystemEvent.ROLE_CHANGED: {
      const role = (data.newRole as string) || "a new role";
      return `${actor} changed ${target}'s role to ${role}`;
    }
    case SystemEvent.ROOM_RENAMED: {
      const name = (data.newName as string) || "";
      return name
        ? `${actor} renamed the group to "${name}"`
        : `${actor} renamed the group`;
    }
    case SystemEvent.AVATAR_CHANGED:
      return `${actor} changed the group photo`;
    case SystemEvent.DESCRIPTION_CHANGED:
      return `${actor} updated the group description`;
    default:
      return `${actor} updated the group`;
  }
}
