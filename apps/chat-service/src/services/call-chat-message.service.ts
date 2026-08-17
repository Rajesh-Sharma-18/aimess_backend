import {
  buildCallTimelineText,
  callContentType,
  isTerminalCallStatus,
  type CallTimelineStatus,
} from "@aimess/constants";
import { logger } from "@aimess/logger";
import type { Redis, Cluster } from "ioredis";

import { publishConvUpdatedSafe } from "../events/publish-conv-updated.js";
import { publishMessageSentSafe } from "../events/publish-message-sent.js";
import { buildChatMessageEvent } from "../lib/chat-message.serializer.js";
import { buildParticipantsKey } from "../lib/room-id.js";
import { SystemEvent } from "../types/enums.js";
import type { PrivateMessage } from "../generated/prisma/index.js";
import type { PrivateMessageRepository } from "../repositories/private-message.repository.js";
import type { PrivateRoomRepository } from "../repositories/private-room.repository.js";

export type CallChatMessageOutcome = CallTimelineStatus;

export interface PostCallChatMessageParams {
  callId: string;
  callerId: string;
  calleeId: string;
  privateRoomId?: string | null;
  callType: string;
  outcome: CallChatMessageOutcome;
  durationSec?: number;
  /** Transition timestamp. NOT the row's timestamp — see `createdAt` below. */
  endedAt: Date;
  endedBy: string;
}

export type GetCallMessageUserSnapshotFn = (
  userId: string
) => Promise<{ displayName: string; avatarUrl: string }>;

export type GetCallMessageUserOnlineFn = (userId: string) => Promise<boolean>;

/** Stable across the WHOLE lifecycle of one call — the upsert key. */
const callClientMessageId = (callId: string): string => `call:${callId}`;

/** Current lifecycle state of a persisted call row ("" if it isn't one). */
export const readCallStatus = (content: unknown): string => {
  const call = (content as { call?: { callStatus?: unknown } } | null)?.call;
  return String(call?.callStatus ?? "").toUpperCase();
};

/**
 * Persists the private DM timeline row for a call.
 *
 * ONE CALL === ONE ROW. The row is written the instant the call starts ringing
 * and then transitions IN PLACE — same message id, same `callId`, same
 * `createdAt` — through every subsequent state:
 *
 *   RINGING → ANSWERED → ENDED
 *   RINGING → DECLINED | MISSED | CANCELLED | FAILED
 *
 * This is what makes the chat behave like WhatsApp: the callee sees the card
 * while their phone is still ringing, and that same card becomes "Declined" /
 * "02:14" instead of a second card appearing beneath the first. `post()` is
 * therefore an UPSERT keyed on `clientMessageId = "call:<callId>"`: insert on
 * first call, update on every later one. The insert broadcasts `message:new`,
 * updates broadcast `message:edited` — both carry the full canonical
 * ChatMessage, so a client applies either by replacing the row with that id.
 *
 * Every row is stored with `messageType` = VOICE_CALL or VIDEO_CALL (see
 * `callContentType`), never SYSTEM, so the persisted kind, the live payload and
 * every read path agree — the client never has to infer "this was a call" from
 * `content.text`.
 *
 * Rows are sender-less (`senderId: ""`): nobody "sent" a call outcome, the call
 * did — and a stable empty sender is also what keeps the upsert key stable
 * across a lifecycle whose final actor is not known when the row is created.
 * Direction is carried explicitly in `content.call.callerId` instead, so the
 * client can render ↗ outgoing / ↙ incoming without guessing from `senderId`.
 * Unread is likewise explicit: only a MISSED call raises a badge, and only on
 * the transition INTO missed, so a ringing card never inflates a counter.
 *
 * This service is internal-only: callers cannot forge these records through the
 * public message send API (VOICE_CALL/VIDEO_CALL are not in the sendable
 * CONTENT_TYPES enum).
 */
export class CallChatMessageService {
  constructor(
    private readonly messageRepo: PrivateMessageRepository,
    private readonly roomRepo: PrivateRoomRepository,
    private readonly redis: Redis | Cluster,
    private readonly getUserSnapshot: GetCallMessageUserSnapshotFn = async () => ({
      displayName: "",
      avatarUrl: "",
    }),
    private readonly getIsOnline?: GetCallMessageUserOnlineFn
  ) {}

  async post(
    params: PostCallChatMessageParams
  ): Promise<PrivateMessage | null> {
    const room = params.privateRoomId
      ? await this.roomRepo.findByRoomId(params.privateRoomId)
      : await this.roomRepo.findByParticipantsKey(
          buildParticipantsKey(params.callerId, params.calleeId)
        );

    const participants = Array.isArray(room?.participants)
      ? (room.participants as string[])
      : [];
    if (
      !room ||
      !participants.includes(params.callerId) ||
      !participants.includes(params.calleeId)
    ) {
      logger.warn(
        `CallChatMessageService|post|private room unavailable callId=${params.callId}`
      );
      return null;
    }

    const status = params.outcome;
    const senderId = "";
    const receiverId = params.calleeId;
    const clientMessageId = callClientMessageId(params.callId);

    const existing = await this.messageRepo.findByClientMessageId(
      room.roomId,
      senderId,
      clientMessageId
    );

    // Terminal is terminal: a late/duplicate transition (retry, racing sweep,
    // LiveKit webhook arriving after the user's own hangup) must never rewrite
    // an ENDED card back to RINGING or overwrite one outcome with another.
    if (existing) {
      const currentStatus = readCallStatus(existing.content);
      if (isTerminalCallStatus(currentStatus) || currentStatus === status) {
        return existing;
      }
    }

    const callLabel =
      params.callType.toUpperCase() === "VIDEO" ? "VIDEO" : "AUDIO";
    const durationSec = Math.max(0, Math.floor(params.durationSec ?? 0));
    const text = buildCallTimelineText({
      callType: callLabel,
      status,
      durationSec,
    });
    // Kind is derived from the CALL's own metadata (`call.type`), never from the
    // rendered text — VOICE_CALL / VIDEO_CALL for every state, so a call row is
    // identifiable as a call (and as which kind of call) on every surface: REST
    // history, /changes, chat:catchup, live message:new/message:edited, inbox.
    const messageType = callContentType(params.callType);
    // CALL_STARTED while the call is live, CALL_ENDED once it settles. Both are
    // lifecycle markers, so `shouldCountInUnread` treats the row as a system row
    // unless `countInUnread` says otherwise — which is exactly what we want.
    const systemEvent = isTerminalCallStatus(status)
      ? SystemEvent.CALL_ENDED
      : SystemEvent.CALL_STARTED;
    const systemData = {
      callId: params.callId,
      callType: callLabel,
      status,
      durationSec,
      callerId: params.callerId,
      calleeId: params.calleeId,
      endedBy: params.endedBy,
    };
    const content = {
      text,
      urls: [],
      files: [],
      call: {
        callId: params.callId,
        callType: callLabel,
        callStatus: status,
        // Legacy alias — pre-lifecycle clients read `outcome`. Same value.
        outcome: status,
        durationSec,
        callerId: params.callerId,
        calleeId: params.calleeId,
      },
    };
    // Only a call the callee never answered raises a badge, and only once — on
    // the transition into MISSED, never while it is merely ringing.
    const countInUnread = status === "MISSED";

    return existing
      ? this.applyTransition({
          params,
          roomId: room.roomId,
          existing,
          content,
          messageType,
          systemEvent,
          systemData,
          countInUnread,
          text,
        })
      : this.createRow({
          params,
          roomId: room.roomId,
          senderId,
          receiverId,
          clientMessageId,
          content,
          messageType,
          systemEvent,
          systemData,
          countInUnread,
          text,
        });
  }

  /** First state of the call — normally RINGING, from `CallService.initiateCall`. */
  private async createRow(args: {
    params: PostCallChatMessageParams;
    roomId: string;
    senderId: string;
    receiverId: string;
    clientMessageId: string;
    content: Record<string, unknown>;
    messageType: string;
    systemEvent: string;
    systemData: Record<string, unknown>;
    countInUnread: boolean;
    text: string;
  }): Promise<PrivateMessage> {
    const {
      params,
      roomId,
      senderId,
      receiverId,
      clientMessageId,
      content,
      messageType,
      systemEvent,
      systemData,
      countInUnread,
      text,
    } = args;

    const sequenceNumber = await this.roomRepo.allocateSequence(roomId);
    const message = await this.messageRepo.createMessage({
      roomId,
      senderId,
      receiverId,
      content,
      messageType,
      systemEvent,
      systemData,
      countInUnread,
      clientMessageId,
      sequenceNumber,
      // The card's timestamp is when the call STARTED and never moves again,
      // even though the row keeps changing — a WhatsApp call card shows the
      // time it rang, not the time it was hung up.
      createdAt: params.endedAt,
    });

    // Keep the durable room snapshot/unread state in lockstep with the row.
    await this.roomRepo
      .updateRoomOnNewMessage({
        roomId,
        message: {
          _id: message.id,
          content: message.content,
          senderId,
          messageType,
          systemEvent,
          systemData,
          createdAt: message.createdAt,
          clientMessageId: message.clientMessageId,
          sequenceNumber: message.sequenceNumber,
          revision: message.revision,
        },
        receiverId,
        unreadIncrement: countInUnread ? 1 : 0,
      })
      .catch((error: unknown) => {
        // The message row is already durable; still broadcast it so open chats
        // update immediately even if this denormalized room snapshot write fails.
        logger.warn(
          `CallChatMessageService|post|room update failed callId=${params.callId}: ${String(error)}`
        );
      });

    await this.broadcast({
      event: "message:new",
      roomId,
      message,
      clientMessageId,
      senderId,
      receiverId,
      messageType,
      systemEvent,
      systemData,
      countInUnread,
      text,
      params,
    });

    return message;
  }

  /**
   * Every state after the first. Rewrites the SAME row and fans it out as
   * `message:edited` so open chats swap the card in place, multi-device peers
   * converge on one card, and `/changes` (via the bumped revision) replays the
   * final state to anyone who was offline for the whole call.
   */
  private async applyTransition(args: {
    params: PostCallChatMessageParams;
    roomId: string;
    existing: PrivateMessage;
    content: Record<string, unknown>;
    messageType: string;
    systemEvent: string;
    systemData: Record<string, unknown>;
    countInUnread: boolean;
    text: string;
  }): Promise<PrivateMessage> {
    const {
      params,
      roomId,
      existing,
      content,
      messageType,
      systemEvent,
      systemData,
      countInUnread,
      text,
    } = args;

    const message = await this.messageRepo.updateCallState({
      messageId: existing.id,
      roomId,
      content,
      messageType,
      systemEvent,
      systemData,
      countInUnread,
    });

    // Refresh the inbox snapshot ONLY while the call row is still the room's
    // last message. If a real message landed mid-call, rewriting lastMessage*
    // here would rewind the inbox row to the call and reorder the list wrongly.
    const room = await this.roomRepo.findByRoomId(roomId).catch(() => null);
    if (room?.lastMessageId === existing.id) {
      await this.roomRepo
        .updateRoomOnNewMessage({
          roomId,
          message: {
            _id: message.id,
            content: message.content,
            senderId: "",
            messageType,
            systemEvent,
            systemData,
            createdAt: existing.createdAt,
            clientMessageId: message.clientMessageId,
            sequenceNumber: message.sequenceNumber,
            revision: message.revision,
          },
          receiverId: params.calleeId,
          // A MISSED call is the one transition that raises the callee's badge.
          unreadIncrement: countInUnread ? 1 : 0,
        })
        .catch((error: unknown) => {
          logger.warn(
            `CallChatMessageService|transition|room update failed callId=${params.callId}: ${String(error)}`
          );
        });
    }

    await this.broadcast({
      event: "message:edited",
      roomId,
      message,
      clientMessageId: callClientMessageId(params.callId),
      senderId: "",
      receiverId: params.calleeId,
      messageType,
      systemEvent,
      systemData,
      countInUnread,
      text,
      params,
      // The row keeps its original timestamp across the whole lifecycle.
      serverTsOverride: existing.createdAt.getTime(),
      sequenceNumberOverride: existing.sequenceNumber,
    });

    return message;
  }

  /**
   * Shared fan-out for both the insert and every transition: the canonical
   * ChatMessage on each participant's `user:<id>` bus, the inbox bump, and
   * (missed calls only) the push fallback.
   */
  private async broadcast(args: {
    event: "message:new" | "message:edited";
    roomId: string;
    message: PrivateMessage;
    clientMessageId: string;
    senderId: string;
    receiverId: string;
    messageType: string;
    systemEvent: string;
    systemData: Record<string, unknown>;
    countInUnread: boolean;
    text: string;
    params: PostCallChatMessageParams;
    serverTsOverride?: number;
    sequenceNumberOverride?: number;
  }): Promise<void> {
    const {
      event,
      roomId,
      message,
      clientMessageId,
      senderId,
      receiverId,
      messageType,
      systemEvent,
      systemData,
      countInUnread,
      text,
      params,
    } = args;

    const serverTs = args.serverTsOverride ?? message.createdAt.getTime();
    const sequenceNumber =
      args.sequenceNumberOverride ?? message.sequenceNumber ?? 0;
    const wire = buildChatMessageEvent({
      id: message.id,
      clientMessageId,
      roomId,
      conversationType: "PRIVATE",
      senderId,
      senderName: "",
      senderAvatar: "",
      receiverId,
      messageType,
      content: message.content,
      reactions: [],
      serverTs,
      sequenceNumber,
      countInUnread,
      systemEvent,
      systemData,
    });

    // The PERSONAL bus, not `conv:<roomId>`. A socket joins `user:<id>` at
    // connect; it joins `conv:<roomId>` only while the client has that exact
    // chat open, and that membership is fragile — a chat switch, a sidebar list
    // change, or a `conv:join` roster check that failed on a transient error all
    // drop it silently, with no rejoin until the page reloads. Every ordinary
    // message survives that because the send path publishes to BOTH channels
    // (see publishMessageNewToParticipants in grpc/service-impl.ts); the call
    // row published only on `conv:` did not, which is why a call card could go
    // missing while the very same chat kept receiving normal messages.
    //
    // Both participants of a private room cover every socket `conv:<roomId>`
    // could have reached (the join is roster-gated, and a private room has
    // exactly these two members), so this is a strict superset — and it stays
    // ONE copy per user, since a second copy of `message:new` for the same row
    // re-enters the client's clientMessageId reconciliation and rewrites the
    // card's direction.
    const payload = JSON.stringify({ event, data: wire });
    await Promise.all(
      [...new Set([params.callerId, params.calleeId])]
        .filter(Boolean)
        .map((userId) =>
          this.redis
            .publish(`user:${userId}`, payload)
            .catch((error: unknown) => {
              logger.warn(
                `CallChatMessageService|${event} publish failed callId=${params.callId} userId=${userId}: ${String(error)}`
              );
            })
        )
    );

    publishConvUpdatedSafe({
      redis: this.redis,
      type: "PRIVATE",
      roomId,
      recipientIds: [params.callerId, params.calleeId],
      senderId,
      senderName: "",
      lastMessageId: message.id,
      lastMessageAt: serverTs,
      // The canonical pair rides along so the gateway re-renders "Missed call" /
      // "Call ended · 2:14" in each participant's own language rather than
      // fanning out the write-time English (publish-conv-updated.ts BumpPreview).
      preview: { contentType: messageType, text, systemEvent, systemData },
      countInUnread,
      getIsOnline: this.getIsOnline,
      // Same absolute-count source as the main send path (chat-message-
      // orchestrator) — without this, conv:updated here falls back to a bare
      // `unread: true/false` flag the client must optimistically +1, which can
      // drift from the room's authoritative unreadCountByUser.
      resolveUnreadCounts: async () => {
        const r = await this.roomRepo.findByRoomId(roomId).catch(() => null);
        return { ...((r?.unreadCountByUser as Record<string, number>) ?? {}) };
      },
    });

    // Push fallback for a call the callee never picked up. Only on the MISSED
    // transition — a ringing card must not push (the VoIP/incoming-call push
    // from CallService already covers that), and an ended/declined card is
    // something the callee was demonstrably present for.
    if (params.outcome === "MISSED") {
      const callerSnapshot = await this.getUserSnapshot(params.callerId).catch(
        () => ({ displayName: "", avatarUrl: "" })
      );
      publishMessageSentSafe({
        conversationId: roomId,
        conversationType: "PRIVATE",
        messageId: message.id,
        clientMessageId,
        senderId: params.callerId,
        senderName: callerSnapshot.displayName,
        senderAvatar: callerSnapshot.avatarUrl,
        preview: text,
        messageType,
        sentAt: serverTs,
        recipientIds: [params.calleeId],
      });
    }
  }
}
