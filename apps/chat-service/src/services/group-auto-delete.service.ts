import { logger } from "@aimess/logger";
import type { Redis, Cluster } from "ioredis";

import { BadRequestError, ForbiddenError, NotFoundError } from "@aimess/errors";

import {
  buildAutoDeleteWire,
  formatAutoDeleteDuration,
  readRoomAutoDelete,
  validateAutoDeleteInput,
  type AutoDeleteMode,
} from "../lib/auto-delete.js";
import { SystemEvent } from "../types/enums.js";
import type { GroupMessageRepository } from "../repositories/group-message.repository.js";
import type { GroupRoomRepository } from "../repositories/group-room.repository.js";
import type { GroupMemberRepository } from "../repositories/group-member.repository.js";
import type { GroupSystemMessageService } from "./group-system-message.service.js";
import type { GroupPinService } from "./group-pin.service.js";
import type { ChatMessageOrchestrator } from "./chat-message-orchestrator.js";

export interface AutoDeleteInput {
  mode: string;
  ttlSeconds?: number | null;
}

/** WhatsApp: only admins change a group's disappearing-messages timer. */
const AUTO_DELETE_ROLES = ["ADMIN", "MODERATOR"];

/**
 * "Automatically Delete Messages" for GROUP chats — the group twin of
 * {@link AutoDeleteService}, and deliberately its mirror image: same stored
 * shape (`GroupRoom.autoDelete`), same `lib/auto-delete.ts` arithmetic, same
 * message columns, same sweep-through-the-normal-delete-path rule. Group and
 * private are separate classes for the same reason `GroupPinService` and
 * `PrivatePinService` are: the repositories, the permission model and the
 * recipient set all differ, and one parameterized class would be a bag of
 * injected adapters rather than shared logic.
 *
 * What differs from private, and why:
 *   - ONE timer for the room, changeable only by ADMIN/MODERATOR, but every
 *     member's messages follow it.
 *   - "After Viewing" arms on the FIRST recipient's read receipt, not the last.
 *     Waiting for every member of a large group would mean "never".
 *   - The sweep deletes `bySystem`, so a message still disappears when its
 *     sender has since left, been kicked, or been muted.
 */
export class GroupAutoDeleteService {
  constructor(
    private readonly roomRepo: GroupRoomRepository,
    private readonly memberRepo: GroupMemberRepository,
    private readonly messageRepo: GroupMessageRepository,
    private readonly systemMessageService: GroupSystemMessageService,
    private readonly pinService: GroupPinService,
    private readonly orchestrator: ChatMessageOrchestrator,
    private readonly redis: Redis | Cluster
  ) {}

  private async loadRoomForMember(roomId: string, userId: string) {
    const [room, member] = await Promise.all([
      this.roomRepo.findActiveByRoomId(roomId),
      this.memberRepo.findActiveByRoomAndUser(roomId, userId),
    ]);
    // NotFound (not Forbidden) for a non-member so a stranger can't probe which
    // group ids exist — same rule the rest of the group surface follows.
    if (!room || !member) throw new NotFoundError("CHAT_ROOM_NOT_FOUND");
    return { room, member };
  }

  /** This group's timer — the same answer for every member. */
  async getSettings(
    roomId: string,
    userId: string
  ): Promise<Record<string, unknown>> {
    const { room } = await this.loadRoomForMember(roomId, userId);
    return buildAutoDeleteWire(readRoomAutoDelete(room));
  }

  /**
   * Set/change/clear THE group's timer. Admin/moderator only; `userId` comes
   * from the request's auth context (never the body) and is recorded as who
   * made the change.
   */
  async updateSetting(
    roomId: string,
    userId: string,
    input: AutoDeleteInput
  ): Promise<Record<string, unknown>> {
    const invalid = validateAutoDeleteInput(input);
    if (invalid) throw new BadRequestError(invalid);

    const mode = String(input.mode).toUpperCase() as AutoDeleteMode;
    const ttlSeconds = mode === "TIMER" ? Number(input.ttlSeconds) : null;

    const { room, member } = await this.loadRoomForMember(roomId, userId);
    if (!AUTO_DELETE_ROLES.includes(member.role))
      throw new ForbiddenError("CHAT_INSUFFICIENT_PERMISSIONS");

    const before = readRoomAutoDelete(room);
    // No-op guard: a repeated tap on the same option must not spam the chat
    // with an identical system message, re-stamp anything, or wake any client.
    if (before.mode === mode && (before.ttlSeconds ?? null) === ttlSeconds) {
      return buildAutoDeleteWire(before);
    }

    const updated = await this.roomRepo.setAutoDelete(roomId, userId, {
      mode,
      ttlSeconds,
    });
    if (!updated) throw new NotFoundError("CHAT_ROOM_NOT_FOUND");
    const after = readRoomAutoDelete(updated);

    // A timer CHANGE (longer or shorter) applies to messages already counting
    // down. Turning it OFF does NOT: messages that already have a deadline keep
    // deleting on schedule, exactly as in private.
    if (mode !== "OFF") {
      await this.messageRepo
        .restampPendingAutoDeletes({
          roomId,
          ttlSeconds,
          afterView: mode === "AFTER_VIEWING",
        })
        .catch((err: unknown) => {
          logger.warn(
            `GroupAutoDeleteService|restamp failed room=${roomId}: ${String(err)}`
          );
        });
    }

    const wire = buildAutoDeleteWire(after);

    // Everyone in the room sees a system line when the setting changes. The
    // service publishes `message:new` to `conv:<roomId>` itself and never
    // throws.
    void this.systemMessageService.post({
      roomId,
      actorId: userId,
      systemEvent: SystemEvent.AUTO_DELETE_UPDATED,
      systemData: {
        mode,
        ttlSeconds,
        durationLabel: formatAutoDeleteDuration(ttlSeconds),
      },
    });

    // Every device of every member updates without a refresh, whatever screen
    // they are on — `conv:<roomId>` only reaches clients with the chat OPEN,
    // and the timer is visible from the group info panel and the chat list too.
    // Published only AFTER the write above succeeded.
    await this.fanOutSettingChange(roomId, userId, wire);

    return wire;
  }

  private async fanOutSettingChange(
    roomId: string,
    actorId: string,
    wire: Record<string, unknown>
  ): Promise<void> {
    try {
      const members = await this.memberRepo.findActiveMembers(roomId);
      const payload = JSON.stringify({
        event: "conv:auto_delete:updated",
        data: {
          roomId,
          conversationId: roomId,
          type: "GROUP",
          actorId,
          ...wire,
        },
      });
      for (const member of members) {
        await this.redis.publish(`user:${member.userId}`, payload);
      }
    } catch (err) {
      logger.warn(
        `GroupAutoDeleteService|setting fan-out failed room=${roomId}: ${String(err)}`
      );
    }
  }

  /**
   * Delete one page of due group messages. Returns how many rows were CLAIMED
   * (the caller keeps draining while this equals the batch size).
   *
   * Multi-node safe without a distributed lock: the delete rejects an
   * already-deleted row, so a node that loses the race simply skips it.
   */
  async sweepDue(now: Date, batchSize: number): Promise<number> {
    const due = await this.messageRepo.findDueAutoDeletes(now, batchSize);
    // One roster lookup per ROOM per sweep, not per message.
    const membersByRoom = new Map<string, string[]>();
    for (const row of due) {
      if (!row.senderId) continue; // system messages are never stamped
      try {
        const { tombstone } = await this.orchestrator.deleteDirect({
          conversationType: "GROUP",
          roomId: row.roomId,
          messageId: row.id,
          userId: row.senderId,
          scope: "forEveryone",
          bySystem: true,
        });
        await this.fanOutTombstone(row.roomId, tombstone, membersByRoom);
        await this.clearPin(row.roomId, row.id);
      } catch (err) {
        // Already deleted by another node / a manual delete that beat us — both
        // are the desired end state, so never let one row stop the page. WARN,
        // not debug: a sweep that deletes the row but cannot broadcast leaves
        // the message on every open client, so the failure must be visible.
        logger.warn(
          `GroupAutoDeleteService|sweep failed messageId=${row.id}: ${String(err)}`
        );
      }
    }
    return due.length;
  }

  /**
   * Deliver the tombstone to every active member's personal channel as well as
   * the room channel `deleteDirect` already published on.
   *
   * `conv:<roomId>` only reaches sockets that ran `conversation:join` — i.e. a
   * client with that chat OPEN. A SWEEP fires with nobody guaranteed to be
   * looking, so without this the client keeps rendering a message the server
   * has already deleted, with a countdown frozen at zero, until something
   * forces a refetch. Duplicate delivery to a joined client is harmless: the
   * tombstone handler removes by id and is idempotent.
   */
  private async fanOutTombstone(
    roomId: string,
    tombstone: Record<string, unknown>,
    cache: Map<string, string[]>
  ): Promise<void> {
    try {
      let memberIds = cache.get(roomId);
      if (!memberIds) {
        const members = await this.memberRepo.findActiveMembers(roomId);
        memberIds = members.map((m) => m.userId).filter(Boolean);
        cache.set(roomId, memberIds);
      }
      const payload = JSON.stringify({
        event: "message:delete",
        data: tombstone,
      });
      for (const userId of memberIds) {
        await this.redis.publish(`user:${userId}`, payload);
      }
    } catch (err) {
      logger.warn(
        `GroupAutoDeleteService|tombstone fan-out failed room=${roomId}: ${String(err)}`
      );
    }
  }

  /** A pinned message that auto-deletes must stop showing in the pin banner. */
  private async clearPin(roomId: string, messageId: string): Promise<void> {
    try {
      const affectedPin = await this.pinService.handleMessageDeleted(messageId);
      if (!affectedPin) return;
      await this.redis.publish(
        `conv:${roomId}`,
        JSON.stringify({
          event: "pin:updated",
          data: {
            roomId,
            conversationId: roomId,
            messageId,
            action: "pinned",
            pinnedCount: null, // unchanged; client uses its cached count
            pin: { ...affectedPin, isAvailable: false },
          },
        })
      );
    } catch (err) {
      logger.warn(
        `GroupAutoDeleteService|pin cleanup failed messageId=${messageId}: ${String(err)}`
      );
    }
  }
}
