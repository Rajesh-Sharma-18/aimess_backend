import { logger } from "@aimess/logger";

import { resolveConversationType } from "../lib/conversation-type.js";
import type { PrivateRoomService } from "./private-room.service.js";
import type { GroupRoomService } from "./group-room.service.js";
import type { GroupMemberService } from "./group-member.service.js";
import type { ChatMessageOrchestrator } from "./chat-message-orchestrator.js";
import type { PrivateRoomRepository } from "../repositories/private-room.repository.js";
import type { GroupRoomRepository } from "../repositories/group-room.repository.js";

export type ConversationType = "PRIVATE" | "GROUP";

export type BulkLeaveStatus = "LEFT" | "DELETED" | "FAILED";

export type BulkLeaveErrorCode =
  | "OWNER_CANNOT_LEAVE"
  | "NOT_MEMBER"
  | "NOT_FOUND";

export interface BulkLeaveItemResult {
  roomId: string;
  type: ConversationType;
  status: BulkLeaveStatus;
  errorCode?: BulkLeaveErrorCode;
}

export interface BulkLeaveResult {
  results: BulkLeaveItemResult[];
  summary: { requested: number; succeeded: number; failed: number };
}

export interface BulkMuteResult {
  muted: string[];
  skipped: string[];
}

export interface BulkUnmuteResult {
  unmuted: string[];
  skipped: string[];
}

export interface BulkMarkReadResult {
  updatedCount: number;
}

/**
 * Bulk (multi-select) conversation operations for the unified private + group
 * inbox — the chat counterpart of community-service's
 * `POST /communities/{leave,mute,read}/bulk`.
 *
 * This service owns NO domain logic of its own. Every item is routed to the
 * EXACT same single-conversation entry point the one-off REST route already
 * calls, so a bulk run and N individual calls produce byte-identical DB writes,
 * system messages, socket fan-out and push behaviour. That is deliberate: the
 * bug class this replaces is a bulk path that forgets one of the single path's
 * side effects (a roster broadcast, a read receipt, a badge push) and silently
 * drifts.
 *
 * Failure model mirrors community's bulk leave: each id is processed
 * independently and a failure is REPORTED, never rolled back — the successful
 * items stay done. There is no cross-item transaction because there is no
 * cross-item invariant; the operations target different rooms in different
 * collections.
 */
export class ConversationBulkService {
  constructor(
    private readonly privateRoomService: PrivateRoomService,
    private readonly groupRoomService: GroupRoomService,
    private readonly groupMemberService: GroupMemberService,
    private readonly orchestrator: ChatMessageOrchestrator,
    private readonly privateRoomRepo: PrivateRoomRepository,
    private readonly groupRoomRepo: GroupRoomRepository
  ) {}

  /**
   * Remove multiple conversations from the caller's list in one call.
   *
   * PRIVATE → `deleteForMe` (the only self-removal a 1-to-1 room has).
   * GROUP   → real membership removal (`groupAction: "LEAVE"`, default) or
   *           history clear (`groupAction: "DELETE"`), see the validator.
   *
   * Always 200: inspect each item's `status`/`errorCode` and the `summary`.
   */
  async bulkLeave(
    userId: string,
    roomIds: string[],
    groupAction: "LEAVE" | "DELETE"
  ): Promise<BulkLeaveResult> {
    const results: BulkLeaveItemResult[] = [];
    let succeeded = 0;
    let failed = 0;

    for (const roomId of roomIds) {
      const type = resolveConversationType(roomId);
      try {
        if (type === "GROUP") {
          if (groupAction === "LEAVE") {
            await this.groupMemberService.leave(roomId, userId);
            results.push({ roomId, type, status: "LEFT" });
          } else {
            await this.groupRoomService.clearConversation(roomId, userId);
            results.push({ roomId, type, status: "DELETED" });
          }
        } else {
          await this.privateRoomService.deleteForMe(roomId, userId);
          results.push({ roomId, type, status: "DELETED" });
        }
        succeeded++;
      } catch (err) {
        const errorCode = toLeaveErrorCode(err);
        logger.warn(
          `ConversationBulkService|leave failed room=${roomId} user=${userId} code=${errorCode}: ${String(err)}`
        );
        results.push({ roomId, type, status: "FAILED", errorCode });
        failed++;
      }
    }

    return {
      results,
      summary: { requested: roomIds.length, succeeded, failed },
    };
  }

  /**
   * Mute multiple conversations for the caller. `durationMinutes` is resolved
   * against the SERVER clock (null/omitted = indefinite), matching
   * `POST /communities/mute/bulk`.
   *
   * Conversation mute suppresses PUSH ONLY. Message delivery, unread counts,
   * `conv:updated` list bumps, receipts and typing are untouched — the
   * suppression lives entirely in the notification path's `checkPrivateMute` /
   * `checkGroupMute` oracle, which also applies expiry lazily, so a mute
   * lapses on its own with no sweeper and no client refresh.
   *
   * A room the caller can't mute (not a participant / not an active member /
   * gone) is SKIPPED, never fatal — community parity.
   */
  async bulkMute(
    userId: string,
    roomIds: string[],
    durationMinutes: number | null | undefined
  ): Promise<BulkMuteResult> {
    // ONE timestamp for the whole batch: 50 sequential writes must not drift
    // the expiry by the wall-clock cost of the loop.
    const muteUntil =
      durationMinutes == null
        ? null
        : new Date(Date.now() + durationMinutes * 60_000);

    const muted: string[] = [];
    const skipped: string[] = [];

    for (const roomId of roomIds) {
      try {
        if (resolveConversationType(roomId) === "GROUP") {
          await this.groupMemberService.muteRoom(roomId, userId, muteUntil);
        } else {
          await this.privateRoomService.muteRoom(roomId, userId, muteUntil);
        }
        muted.push(roomId);
      } catch (err) {
        logger.warn(
          `ConversationBulkService|mute skipped room=${roomId} user=${userId}: ${String(err)}`
        );
        skipped.push(roomId);
      }
    }

    return { muted, skipped };
  }

  async bulkUnmute(
    userId: string,
    roomIds: string[]
  ): Promise<BulkUnmuteResult> {
    const unmuted: string[] = [];
    const skipped: string[] = [];

    for (const roomId of roomIds) {
      try {
        if (resolveConversationType(roomId) === "GROUP") {
          await this.groupMemberService.unmuteRoom(roomId, userId);
        } else {
          await this.privateRoomService.unmuteRoom(roomId, userId);
        }
        unmuted.push(roomId);
      } catch (err) {
        logger.warn(
          `ConversationBulkService|unmute skipped room=${roomId} user=${userId}: ${String(err)}`
        );
        skipped.push(roomId);
      }
    }

    return { unmuted, skipped };
  }

  /**
   * Zero the caller's unread count on multiple conversations.
   *
   * Each room is read up to its CURRENT last message, resolved server-side —
   * the client never supplies a boundary id, so it cannot mark a conversation
   * read past a message that arrived after it rendered the list. Routed
   * through `ChatMessageOrchestrator.markReadDirect`, the same entry point the
   * per-room `POST .../read` uses, so every read effect still fires: the read
   * pointer advances forward-only, `message:read` reaches the sender(s),
   * `read_sync` reaches the caller's OTHER devices, the nav badge total is
   * recomputed and the tray notification is dismissed.
   *
   * Forward-only is also what makes this race-safe: if a newer message lands
   * between the boundary resolution and the write, the pointer simply stops at
   * the older boundary and unread stays > 0 — it never over-reads to zero.
   *
   * `updatedCount` counts rooms actually advanced; an empty room (no last
   * message) or one the caller can no longer read is silently skipped, matching
   * `POST /communities/read/bulk`.
   */
  async bulkMarkRead(
    userId: string,
    roomIds: string[]
  ): Promise<BulkMarkReadResult> {
    let updatedCount = 0;

    for (const roomId of roomIds) {
      const conversationType = resolveConversationType(roomId);
      try {
        const upToMessageId = await this.resolveLastMessageId(
          roomId,
          conversationType
        );
        if (!upToMessageId) continue;

        const { readToSeq } = await this.orchestrator.markReadDirect({
          conversationType,
          roomId,
          readerId: userId,
          upToMessageId,
        });
        // readToSeq === 0 means the read was rejected downstream (not a member,
        // message not in this room, temp id) — do not report it as updated.
        if (readToSeq > 0) updatedCount++;
      } catch (err) {
        logger.warn(
          `ConversationBulkService|markRead skipped room=${roomId} user=${userId}: ${String(err)}`
        );
      }
    }

    return { updatedCount };
  }

  private async resolveLastMessageId(
    roomId: string,
    type: ConversationType
  ): Promise<string | null> {
    if (type === "GROUP") {
      const room = await this.groupRoomRepo.findActiveByRoomId(roomId);
      return room?.lastMessageId ?? null;
    }
    const room = await this.privateRoomRepo.findByRoomId(roomId);
    return room?.lastMessageId ?? null;
  }
}

/**
 * Map the single-conversation services' thrown AppErrors onto the bulk item
 * error codes. The message codes are the ones those services actually throw
 * (`CHAT_NOT_A_MEMBER`, `CHAT_OWNER_CANNOT_LEAVE`, `CHAT_ROOM_NOT_FOUND`);
 * anything unrecognized degrades to NOT_FOUND rather than failing the batch.
 */
function toLeaveErrorCode(err: unknown): BulkLeaveErrorCode {
  const code = (err as { message?: string })?.message ?? "";
  if (code === "CHAT_OWNER_CANNOT_LEAVE") return "OWNER_CANNOT_LEAVE";
  if (code === "CHAT_NOT_A_MEMBER") return "NOT_MEMBER";
  return "NOT_FOUND";
}
