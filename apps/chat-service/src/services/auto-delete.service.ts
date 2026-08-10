import { logger } from "@aimess/logger";
import type { Redis, Cluster } from "ioredis";

import { BadRequestError, NotFoundError } from "@aimess/errors";

import {
  buildAutoDeleteWire,
  formatAutoDeleteDuration,
  hasExplicitAutoDelete,
  parseAutoDeleteMap,
  readAutoDeleteSetting,
  validateAutoDeleteInput,
  type AutoDeleteMode,
} from "../lib/auto-delete.js";
import { getAccountAutoDelete } from "../lib/account-chat-settings.js";
import { SystemEvent } from "../types/enums.js";
import type { PrivateMessageRepository } from "../repositories/private-message.repository.js";
import type { PrivateRoomRepository } from "../repositories/private-room.repository.js";
import type { PrivateSystemMessageService } from "./private-system-message.service.js";
import type { PrivatePinService } from "./private-pin.service.js";
import type { ChatMessageOrchestrator } from "./chat-message-orchestrator.js";

export interface AutoDeleteInput {
  mode: string;
  ttlSeconds?: number | null;
}

/**
 * "Automatically Delete Messages" for PRIVATE 1:1 chats.
 *
 * Owns the three moving parts the feature needs beyond the send path (which
 * stamps each new message itself — see `PrivateMessageService.sendMessage`):
 *
 *   1. the per-user setting (read/write + system message + realtime fan-out),
 *   2. re-stamping messages already counting down when the timer CHANGES,
 *   3. the sweeper that actually deletes due messages.
 *
 * Deletion deliberately routes through `ChatMessageOrchestrator.deleteDirect`
 * — the same entry point a manual "delete for everyone" uses — so an
 * auto-deleted message produces byte-identical effects (tombstone broadcast,
 * unread decrement, reply-quote refresh, inbox preview recalculation) instead
 * of a thinner parallel implementation that would drift.
 */
export class AutoDeleteService {
  constructor(
    private readonly roomRepo: PrivateRoomRepository,
    private readonly messageRepo: PrivateMessageRepository,
    private readonly systemMessageService: PrivateSystemMessageService,
    private readonly pinService: PrivatePinService,
    private readonly orchestrator: ChatMessageOrchestrator,
    private readonly redis: Redis | Cluster
  ) {}

  private async loadRoom(roomId: string, userId: string) {
    const room = await this.roomRepo.findByRoomId(roomId);
    if (!room || !room.participants?.includes(userId))
      throw new NotFoundError("CHAT_ROOM_NOT_FOUND");
    const peerId = (room.participants ?? []).find((id) => id !== userId) ?? "";
    return { room, peerId };
  }

  /** Current setting for both sides + which one MY next message will follow. */
  async getSettings(
    roomId: string,
    userId: string
  ): Promise<Record<string, unknown>> {
    const { room, peerId } = await this.loadRoom(roomId, userId);
    const map = parseAutoDeleteMap(room.autoDeleteBy);
    return buildAutoDeleteWire(
      map,
      userId,
      peerId,
      await getAccountAutoDelete(userId)
    );
  }

  /**
   * Set/change/clear the caller's own timer. One-sided by design: the peer is
   * informed (system message + realtime event) but never asked to approve.
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

    const { room, peerId } = await this.loadRoom(roomId, userId);
    const accountDefault = await getAccountAutoDelete(userId);
    const mapBefore = parseAutoDeleteMap(room.autoDeleteBy);
    const before = readAutoDeleteSetting(mapBefore, userId);
    // No-op guard: a repeated tap on the same option must not spam the chat
    // with an identical system message or re-stamp anything. Picking OFF while
    // never having configured this chat is NOT a no-op — it is what pins the
    // chat against the account-wide default, so it must reach the write below.
    const alreadyRecorded =
      mode !== "OFF" || hasExplicitAutoDelete(mapBefore, userId);
    if (
      alreadyRecorded &&
      before.mode === mode &&
      (before.ttlSeconds ?? null) === ttlSeconds
    ) {
      return buildAutoDeleteWire(mapBefore, userId, peerId, accountDefault);
    }

    const updated = await this.roomRepo.setAutoDelete(roomId, userId, {
      mode,
      ttlSeconds,
    });
    const map = parseAutoDeleteMap(updated?.autoDeleteBy ?? {});

    // §8.8 — a timer CHANGE (longer or shorter) applies to messages already
    // counting down. Turning it OFF does NOT: §7 is explicit that messages that
    // already have a timer keep deleting on schedule.
    if (mode !== "OFF") {
      // Which messages this user's setting governs: always their own, plus the
      // peer's when the peer has no setting of their own (one-sided case —
      // the peer's messages are following THIS user's timer).
      const senderIds = [userId];
      if (peerId && readAutoDeleteSetting(map, peerId).mode === "OFF")
        senderIds.push(peerId);
      await this.messageRepo
        .restampPendingAutoDeletes({
          roomId,
          senderIds,
          ttlSeconds,
          afterView: mode === "AFTER_VIEWING",
        })
        .catch((err: unknown) => {
          logger.warn(
            `AutoDeleteService|restamp failed room=${roomId}: ${String(err)}`
          );
        });
    }

    const wire = buildAutoDeleteWire(map, userId, peerId, accountDefault);

    // §2 / §7 — both sides see a system message in the chat when the setting
    // changes. Best-effort inside the system-message service; never throws.
    void this.systemMessageService.post({
      roomId,
      actorId: userId,
      peerId,
      systemEvent: SystemEvent.AUTO_DELETE_UPDATED,
      systemData: {
        mode,
        ttlSeconds,
        durationLabel: formatAutoDeleteDuration(ttlSeconds),
      },
    });

    // §8.4 — every device of BOTH participants updates the gear-menu state
    // without a refresh. Per-recipient payload so each side sees its own
    // self/peer split and its own effective timer.
    for (const recipientId of [userId, peerId].filter(Boolean)) {
      const otherId = recipientId === userId ? peerId : userId;
      // Each side's effective timer is resolved against ITS OWN account-wide
      // default, so the peer can't be told my default is in force for them.
      const recipientDefault =
        recipientId === userId
          ? accountDefault
          : await getAccountAutoDelete(recipientId);
      void this.redis
        .publish(
          `user:${recipientId}`,
          JSON.stringify({
            event: "conv:auto_delete:updated",
            data: {
              roomId,
              conversationId: roomId,
              type: "PRIVATE",
              actorId: userId,
              ...buildAutoDeleteWire(
                map,
                recipientId,
                otherId,
                recipientDefault
              ),
            },
          })
        )
        .catch(() => {});
    }

    return wire;
  }

  /**
   * Delete one page of due messages. Returns how many rows were CLAIMED (the
   * caller keeps draining while this equals the batch size).
   *
   * Multi-node safe without a distributed lock: `deleteForEveryone` rejects an
   * already-deleted row, so a node that loses the race simply skips it.
   */
  async sweepDue(now: Date, batchSize: number): Promise<number> {
    const due = await this.messageRepo.findDueAutoDeletes(now, batchSize);
    // One participants lookup per ROOM per sweep, not per message.
    const participantsByRoom = new Map<string, string[]>();
    for (const row of due) {
      if (!row.senderId) continue; // system messages are never stamped
      try {
        const { tombstone } = await this.orchestrator.deleteDirect({
          conversationType: "PRIVATE",
          roomId: row.roomId,
          messageId: row.id,
          userId: row.senderId,
          scope: "forEveryone",
        });
        await this.fanOutTombstone(row.roomId, tombstone, participantsByRoom);
        await this.clearPin(row.roomId, row.id);
      } catch (err) {
        // Already deleted by another node / a manual delete that beat us — both
        // are the desired end state, so never let one row stop the page.
        //
        // WARN, not debug: this used to be `logger.debug?.()`, which in a dev
        // environment (level=info) discarded the reason a message failed to
        // sweep. A sweep that deletes the row but cannot broadcast leaves the
        // message on every open client, so the failure must be visible.
        logger.warn(
          `AutoDeleteService|sweep failed messageId=${row.id}: ${String(err)}`
        );
      }
    }
    return due.length;
  }

  /**
   * Deliver the tombstone to BOTH participants' personal channels as well as the
   * room channel `deleteDirect` already published on.
   *
   * `conv:<roomId>` only reaches sockets that ran `conversation:join` — i.e. a
   * client with that chat OPEN. For a user-initiated delete that is usually
   * fine, but a SWEEP fires with nobody guaranteed to be looking: the client
   * then keeps rendering a message the server has already deleted, with a
   * countdown frozen at zero, until something forces a refetch. Mirrors the
   * personal fan-out `message:new` already does for the same reason.
   *
   * Duplicate delivery to a client that IS joined is harmless — the tombstone
   * handler removes by id and is idempotent.
   */
  private async fanOutTombstone(
    roomId: string,
    tombstone: Record<string, unknown>,
    cache: Map<string, string[]>
  ): Promise<void> {
    try {
      let participants = cache.get(roomId);
      if (!participants) {
        const room = await this.roomRepo.findByRoomId(roomId);
        participants = (room?.participants ?? []).filter(Boolean);
        cache.set(roomId, participants);
      }
      const payload = JSON.stringify({
        event: "message:delete",
        data: tombstone,
      });
      for (const userId of participants) {
        await this.redis.publish(`user:${userId}`, payload);
      }
    } catch (err) {
      logger.warn(
        `AutoDeleteService|tombstone fan-out failed room=${roomId}: ${String(err)}`
      );
    }
  }

  /** §4 — a pinned message that auto-deletes must stop showing in the pin banner. */
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
        `AutoDeleteService|pin cleanup failed messageId=${messageId}: ${String(err)}`
      );
    }
  }
}
