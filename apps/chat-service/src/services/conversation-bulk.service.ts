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

/** What `bulkLeave` does to a GROUP row — see the validator for the contract. */
export type GroupBulkLeaveAction = "LEAVE" | "DELETE" | "LEAVE_AND_DELETE";

export type BulkLeaveErrorCode =
  | "OWNER_CANNOT_LEAVE"
  | "NOT_MEMBER"
  | "NOT_FOUND"
  /**
   * The id is neither `prv_…` nor `grp_…`, so this service cannot own it. In
   * practice that means a COMMUNITY id: community mute/read state lives in
   * community-service (`CommunityMuteSetting`) and its own room membership, and
   * is reached through `POST /communities/{mute,read}/bulk`. Reported per item
   * instead of quietly landing in `skipped`, which read as "already done".
   */
  | "UNSUPPORTED_ROOM_TYPE";

export interface BulkItemFailure {
  roomId: string;
  errorCode: BulkLeaveErrorCode;
}

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

/**
 * `skipped` is retained verbatim (every id that did not succeed) so existing
 * clients keep working; `failed` adds the REASON per id. A bulk call that
 * reported plain success while quietly dropping half its input is the thing
 * these fields exist to prevent.
 */
export interface BulkMuteResult {
  muted: string[];
  skipped: string[];
  failed: BulkItemFailure[];
}

export interface BulkUnmuteResult {
  unmuted: string[];
  skipped: string[];
  failed: BulkItemFailure[];
}

export interface BulkMarkReadResult {
  updatedCount: number;
  updated: string[];
  failed: BulkItemFailure[];
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
   * GROUP   → real membership removal (`groupAction: "LEAVE"`, default),
   *           history clear (`groupAction: "DELETE"`), or both
   *           (`groupAction: "LEAVE_AND_DELETE"`), see the validator.
   *
   * Always 200: inspect each item's `status`/`errorCode` and the `summary`.
   */
  async bulkLeave(
    userId: string,
    roomIds: string[],
    groupAction: GroupBulkLeaveAction
  ): Promise<BulkLeaveResult> {
    const results: BulkLeaveItemResult[] = [];
    let succeeded = 0;
    let failed = 0;

    for (const roomId of roomIds) {
      const type = resolveConversationType(roomId);
      try {
        if (type === "GROUP") {
          if (groupAction === "LEAVE_AND_DELETE") {
            await this.leaveAndDelete(roomId, userId);
            results.push({ roomId, type, status: "LEFT" });
          } else if (groupAction === "LEAVE") {
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
   * `groupAction: "LEAVE_AND_DELETE"` — the sidebar's "Delete Conversation" on a
   * group the caller is still an ACTIVE member of. WhatsApp semantics: you leave
   * the group AND the row goes away, instead of lingering as the read-only LEFT
   * row a plain "LEAVE" produces.
   *
   * Composed from the two existing single-conversation operations, in this
   * order, so neither grows a second implementation:
   *
   *   1. `GroupMemberService.leave` — MEMBER_LEFT system message, memberCount
   *      decrement, `group:removed` to the leaver, roster fan-out to the rest.
   *   2. `GroupRoomService.clearConversation` — the caller's own `clearedAt`
   *      cutoff, which is what takes the row out of their inbox and their group
   *      search results. Accepts LEFT members, so step 1 does not lock it out.
   *
   * IDEMPOTENT by construction. `leave` throws CHAT_NOT_A_MEMBER when the caller
   * is not ACTIVE — a double-click, a second device that already ran this, or an
   * admin who removed them while the confirm dialog sat open. In every one of
   * those the membership is ALREADY ended, which is the caller's intent, so the
   * clear still runs and the item reports LEFT. No duplicate MEMBER_LEFT line
   * and no duplicate `group:removed` can be emitted, because only the call that
   * actually flipped the status gets past `leave`.
   *
   * CHAT_OWNER_CANNOT_LEAVE is NOT swallowed: the owner has to transfer
   * ownership or disband, and silently clearing their conversation while they
   * stay in the group would be the wrong half of the operation.
   */
  private async leaveAndDelete(roomId: string, userId: string): Promise<void> {
    try {
      await this.groupMemberService.leave(roomId, userId);
    } catch (err) {
      if (toLeaveErrorCode(err) !== "NOT_MEMBER") throw err;
    }
    await this.groupRoomService.clearConversation(roomId, userId);
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
    const failed: BulkItemFailure[] = [];

    for (const roomId of roomIds) {
      if (!isChatRoomId(roomId)) {
        skipped.push(roomId);
        failed.push({ roomId, errorCode: "UNSUPPORTED_ROOM_TYPE" });
        continue;
      }
      try {
        if (resolveConversationType(roomId) === "GROUP") {
          await this.groupMemberService.muteRoom(roomId, userId, muteUntil);
        } else {
          await this.privateRoomService.muteRoom(roomId, userId, muteUntil);
        }
        muted.push(roomId);
      } catch (err) {
        const errorCode = toBulkErrorCode(err);
        logger.warn(
          `ConversationBulkService|mute skipped room=${roomId} user=${userId} code=${errorCode}: ${String(err)}`
        );
        skipped.push(roomId);
        failed.push({ roomId, errorCode });
      }
    }

    return { muted, skipped, failed };
  }

  async bulkUnmute(
    userId: string,
    roomIds: string[]
  ): Promise<BulkUnmuteResult> {
    const unmuted: string[] = [];
    const skipped: string[] = [];
    const failed: BulkItemFailure[] = [];

    for (const roomId of roomIds) {
      if (!isChatRoomId(roomId)) {
        skipped.push(roomId);
        failed.push({ roomId, errorCode: "UNSUPPORTED_ROOM_TYPE" });
        continue;
      }
      try {
        if (resolveConversationType(roomId) === "GROUP") {
          await this.groupMemberService.unmuteRoom(roomId, userId);
        } else {
          await this.privateRoomService.unmuteRoom(roomId, userId);
        }
        unmuted.push(roomId);
      } catch (err) {
        const errorCode = toBulkErrorCode(err);
        logger.warn(
          `ConversationBulkService|unmute skipped room=${roomId} user=${userId} code=${errorCode}: ${String(err)}`
        );
        skipped.push(roomId);
        failed.push({ roomId, errorCode });
      }
    }

    return { unmuted, skipped, failed };
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
    const updated: string[] = [];
    const failed: BulkItemFailure[] = [];

    for (const roomId of roomIds) {
      if (!isChatRoomId(roomId)) {
        failed.push({ roomId, errorCode: "UNSUPPORTED_ROOM_TYPE" });
        continue;
      }
      const conversationType = resolveConversationType(roomId);
      try {
        const upToMessageId = await this.resolveLastMessageId(
          roomId,
          conversationType
        );
        // An empty room has nothing to read — already "read", not a failure.
        if (!upToMessageId) continue;

        const { readToSeq } = await this.orchestrator.markReadDirect({
          conversationType,
          roomId,
          readerId: userId,
          upToMessageId,
        });
        // readToSeq === 0 means the read was rejected downstream (not a member,
        // message not in this room, temp id) — do not report it as updated.
        if (readToSeq > 0) updated.push(roomId);
        else failed.push({ roomId, errorCode: "NOT_MEMBER" });
      } catch (err) {
        const errorCode = toBulkErrorCode(err);
        logger.warn(
          `ConversationBulkService|markRead skipped room=${roomId} user=${userId} code=${errorCode}: ${String(err)}`
        );
        failed.push({ roomId, errorCode });
      }
    }

    return { updatedCount: updated.length, updated, failed };
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

/** Same mapping for mute/read, which have no owner-can't-leave case. */
const toBulkErrorCode = toLeaveErrorCode;

/**
 * Room ids are server-minted with a kind prefix (`generateRoomId("grp"|"prv")`),
 * so anything else did not come from this service — most often a COMMUNITY id
 * (a bare ObjectId), which belongs to `POST /communities/{mute,read}/bulk`.
 * Without this guard `resolveConversationType`'s legacy fallback classified it
 * PRIVATE, the private lookup missed, and the id disappeared into `skipped`
 * looking like a no-op success.
 */
function isChatRoomId(roomId: string): boolean {
  return roomId.startsWith("grp_") || roomId.startsWith("prv_");
}
