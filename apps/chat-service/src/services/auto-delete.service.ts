import { randomUUID } from "node:crypto";

import { logger } from "@aimess/logger";
import type { Redis, Cluster } from "ioredis";

import { BadRequestError, NotFoundError } from "@aimess/errors";

import {
  buildAutoDeleteWire,
  formatAutoDeleteDuration,
  readPolicyVersion,
  readRoomAutoDelete,
  validateAutoDeleteInput,
  type AutoDeleteMode,
} from "../lib/auto-delete.js";
import { AUTO_DELETE_STUCK_ATTEMPTS } from "../lib/auto-delete-claim.js";
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

/** What one sweep page actually did — see {@link AutoDeleteService.sweepDue}. */
export interface SweepResult {
  /** Rows this worker leased. Drives the caller's drain loop. */
  claimed: number;
  /** Rows whose canonical delete completed. */
  completed: number;
  /** Rows whose delete threw and were handed back with backoff. */
  failed: number;
}

/**
 * "Automatically Delete Messages" for PRIVATE 1:1 chats.
 *
 * Owns the four things the feature needs beyond the send path (which stamps
 * each new message itself — see `PrivateMessageService.sendMessage`):
 *
 *   1. the room policy (read/write + system message + realtime fan-out),
 *   2. re-stamping messages already counting down when the timer CHANGES —
 *      durably, via `PrivateRoom.autoDeleteRestampPending`,
 *   3. the sweeper that actually deletes due messages, exactly once across
 *      replicas via the claim/lease in `lib/auto-delete-claim.ts`,
 *   4. the repair pass that finishes a restamp a crash interrupted.
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

  /**
   * The canonical room-policy DTO for this conversation — identical shape to
   * the group endpoint, the PUT response and the socket event. Either
   * participant may edit a private policy, so `canEdit` is always true here.
   */
  private wire(room: {
    autoDelete?: unknown;
    autoDeleteBy?: unknown;
    autoDeletePolicyVersion?: number | null;
  }): Record<string, unknown> {
    return buildAutoDeleteWire(readRoomAutoDelete(room), {
      conversationType: "PRIVATE",
      policyVersion: readPolicyVersion(room),
      canEdit: true,
    });
  }

  /** This conversation's timer — the same answer for either participant. */
  async getSettings(
    roomId: string,
    userId: string
  ): Promise<Record<string, unknown>> {
    const { room } = await this.loadRoom(roomId, userId);
    return this.wire(room);
  }

  /**
   * Set/change/clear THE conversation's timer. Either participant may do it and
   * both then follow it; `userId` comes from the request's auth context (never
   * the body) and is recorded only as who made the change.
   */
  async updateSetting(
    roomId: string,
    userId: string,
    input: AutoDeleteInput
  ): Promise<Record<string, unknown>> {
    const invalid = validateAutoDeleteInput(input, "PRIVATE");
    if (invalid) throw new BadRequestError(invalid);

    const mode = String(input.mode).toUpperCase() as AutoDeleteMode;
    const ttlSeconds = mode === "TIMER" ? Number(input.ttlSeconds) : null;

    const { room, peerId } = await this.loadRoom(roomId, userId);
    const before = readRoomAutoDelete(room);
    // No-op guard: a repeated tap on the same option must not spam the chat with
    // an identical system message, allocate a policy version, re-stamp anything,
    // or wake the other client.
    if (before.mode === mode && (before.ttlSeconds ?? null) === ttlSeconds) {
      return this.wire(room);
    }

    // ONE atomic write: policy + its new version + the durable restamp intent.
    const updated = await this.roomRepo.setAutoDelete(roomId, userId, {
      mode,
      ttlSeconds,
    });
    if (!updated) throw new NotFoundError("CHAT_ROOM_NOT_FOUND");
    const policyVersion = readPolicyVersion(updated);

    // §8.8 — a timer CHANGE (longer or shorter) applies to messages already
    // counting down. Turning it OFF does NOT: §7 is explicit that messages that
    // already have a timer keep deleting on schedule, so `setAutoDelete` leaves
    // no pending intent for OFF and there is nothing to run here.
    //
    // AWAITED, unlike before. A failure no longer disappears into a `.catch`:
    // the pending marker written above survives it and `sweepPendingRestamps`
    // finishes the job, so the response can say `restampPending: true` instead
    // of claiming a change that never reached the messages.
    const restampPending =
      mode === "OFF"
        ? false
        : !(await this.runRestamp({
            roomId,
            senderIds: [userId, peerId].filter(Boolean),
            ttlSeconds,
            afterView: mode === "AFTER_VIEWING",
            policyVersion,
          }));

    const wire = { ...this.wire(updated), restampPending };

    // §2 / §7 — both sides see a system message in the chat when the setting
    // changes. Best-effort inside the system-message service; never throws.
    // Posted HERE and never in the repair pass, so a retried restamp cannot
    // produce a second system line or a second socket event.
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

    // §8.4 — every device of BOTH participants updates without a refresh. The
    // timer belongs to the conversation, so both sides get the SAME payload,
    // and it is published only AFTER the write above succeeded. `user:<id>` is
    // per-user and reaches every session that user has open, whatever screen
    // they are on; nobody outside this pair is subscribed to either channel.
    const payload = JSON.stringify({
      event: "conv:auto_delete:updated",
      data: {
        roomId,
        conversationId: roomId,
        type: "PRIVATE",
        actorId: userId,
        ...wire,
      },
    });
    for (const recipientId of [userId, peerId].filter(Boolean)) {
      void this.redis.publish(`user:${recipientId}`, payload).catch(() => {});
    }

    return wire;
  }

  /**
   * Re-stamp enrolled rows and retire the pending marker. Returns true when the
   * room is fully settled, false when the work is still owed (and therefore
   * still recorded for the repair pass).
   *
   * The clear is conditional on `policyVersion`: if a newer PUT landed while we
   * were re-stamping it has written its own, higher pending version and owes
   * its own pass — clearing unconditionally would discard that.
   */
  private async runRestamp(params: {
    roomId: string;
    senderIds: string[];
    ttlSeconds: number | null;
    afterView: boolean;
    policyVersion: number;
  }): Promise<boolean> {
    try {
      await this.messageRepo.restampPendingAutoDeletes({
        roomId: params.roomId,
        senderIds: params.senderIds,
        ttlSeconds: params.ttlSeconds,
        afterView: params.afterView,
      });
      await this.roomRepo.clearAutoDeleteRestampPending(
        params.roomId,
        params.policyVersion
      );
      return true;
    } catch (err) {
      logger.warn(
        `AutoDeleteService|restamp deferred room=${params.roomId} version=${params.policyVersion}: ${String(err)}`
      );
      return false;
    }
  }

  /**
   * Repair pass for restamps that never completed — a crash between the policy
   * write and the message write, or a transient DB failure during it.
   *
   * Always re-stamps from the room's CURRENT policy rather than a remembered
   * one, so a room that changed twice while the repair was owed converges on
   * the latest value instead of replaying an intermediate one. Returns how many
   * rooms it settled.
   */
  async sweepPendingRestamps(limit: number): Promise<number> {
    const rooms = await this.roomRepo.findPendingAutoDeleteRestamps(limit);
    let settled = 0;
    for (const room of rooms) {
      const setting = readRoomAutoDelete(room);
      const pending = (room as { autoDeleteRestampPending?: number | null })
        .autoDeleteRestampPending;
      if (typeof pending !== "number") continue;
      // The policy was turned OFF after the intent was written — nothing to
      // re-stamp, just retire the marker.
      if (setting.mode === "OFF") {
        await this.roomRepo
          .clearAutoDeleteRestampPending(room.roomId, pending)
          .catch(() => false);
        settled += 1;
        continue;
      }
      const ok = await this.runRestamp({
        roomId: room.roomId,
        senderIds: (room.participants ?? []).filter(Boolean),
        ttlSeconds: setting.ttlSeconds,
        afterView: setting.mode === "AFTER_VIEWING",
        policyVersion: pending,
      });
      if (ok) settled += 1;
    }
    return settled;
  }

  /**
   * Delete one page of due messages.
   *
   * Rows are LEASED before anything is deleted (see `lib/auto-delete-claim.ts`),
   * so of N replicas racing the same due row exactly one runs the canonical
   * delete and its side effects. The previous "delete and swallow the error if
   * someone beat us" shape ran the full side-effect chain on every replica.
   */
  async sweepDue(now: Date, batchSize: number): Promise<SweepResult> {
    const claimed = await this.messageRepo.claimDueAutoDeletes({
      now,
      limit: batchSize,
      token: randomUUID(),
    });
    // One participants lookup per ROOM per sweep, not per message.
    const participantsByRoom = new Map<string, string[]>();
    let completed = 0;
    let failed = 0;
    for (const row of claimed) {
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
        completed += 1;
      } catch (err) {
        failed += 1;
        // Hand the row back with bounded backoff rather than re-attempting it on
        // every 30s tick forever. A manual delete that beat us is the desired
        // end state and will simply never be selected again (`isDeleted`
        // excludes it); anything else is a real failure worth diagnosing.
        //
        // WARN, not debug: a sweep that deletes the row but cannot broadcast
        // leaves the message on every open client, so the failure must be
        // visible. Escalates once a row looks genuinely stuck.
        const message = String(err);
        const log =
          row.attempts >= AUTO_DELETE_STUCK_ATTEMPTS ? logger.error : logger.warn;
        log(
          `AutoDeleteService|sweep failed messageId=${row.id} attempt=${row.attempts}: ${message}`
        );
        await this.messageRepo
          .releaseAutoDeleteClaim({
            id: row.id,
            attempts: row.attempts,
            error: message,
            now,
          })
          .catch((releaseErr: unknown) => {
            // The lease expiry recovers the row one interval later, so this is
            // a diagnostics loss, not a correctness one.
            logger.warn(
              `AutoDeleteService|claim release failed messageId=${row.id}: ${String(releaseErr)}`
            );
          });
      }
    }
    return { claimed: claimed.length, completed, failed };
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
