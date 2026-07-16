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

export type CallChatMessageOutcome = "ENDED" | "MISSED";

export interface PostCallChatMessageParams {
  callId: string;
  callerId: string;
  calleeId: string;
  privateRoomId?: string | null;
  callType: string;
  outcome: CallChatMessageOutcome;
  durationSec?: number;
  endedAt: Date;
  endedBy: string;
}

export type GetCallMessageUserSnapshotFn = (
  userId: string
) => Promise<{ displayName: string; avatarUrl: string }>;

export type GetCallMessageUserOnlineFn = (userId: string) => Promise<boolean>;

const formatCallDuration = (durationSec: number): string => {
  const total = Math.max(0, Math.floor(durationSec));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${mm}:${ss}`
    : `${mm}:${ss}`;
};

/**
 * Persists call lifecycle entries into the private DM timeline.
 *
 * Completed calls are sender-less SYSTEM/CALL_ENDED audit rows and therefore
 * do not count as unread. A timed-out call is deliberately a normal TEXT row
 * from caller to callee, so it behaves like ordinary chat (unread, inbox bump,
 * and push fallback). This service is internal-only: callers cannot forge these
 * records through the public message send API.
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

    const isEnded = params.outcome === "ENDED";
    const senderId = isEnded ? "" : params.callerId;
    const receiverId = params.calleeId;
    const clientMessageId = `call:${params.callId}:${params.outcome.toLowerCase()}`;

    // A terminal Call transition is atomic, so normally there is one writer.
    // Keep this deterministic lookup as a second idempotency barrier for retries.
    const existing = await this.messageRepo.findByClientMessageId(
      room.roomId,
      senderId,
      clientMessageId
    );
    if (existing) return existing;

    const callLabel =
      params.callType.toUpperCase() === "VIDEO" ? "Video" : "Voice";
    const durationSec = Math.max(0, Math.floor(params.durationSec ?? 0));
    const text = isEnded
      ? `${callLabel} call lasted ${formatCallDuration(durationSec)}`
      : `${callLabel} call was not answered`;
    const messageType = isEnded ? "SYSTEM" : "TEXT";
    const systemEvent = isEnded ? SystemEvent.CALL_ENDED : null;
    const systemData = isEnded
      ? {
          callId: params.callId,
          callType: params.callType.toUpperCase(),
          status: "ENDED",
          durationSec,
          callerId: params.callerId,
          calleeId: params.calleeId,
          endedBy: params.endedBy,
        }
      : null;
    const content = {
      text,
      urls: [],
      files: [],
      call: {
        callId: params.callId,
        callType: params.callType.toUpperCase(),
        outcome: params.outcome,
        durationSec,
      },
    };
    const countInUnread = !isEnded;
    const sequenceNumber = await this.roomRepo.allocateSequence(room.roomId);
    const message = await this.messageRepo.createMessage({
      roomId: room.roomId,
      senderId,
      receiverId,
      content,
      messageType,
      systemEvent,
      systemData,
      countInUnread,
      clientMessageId,
      sequenceNumber,
      createdAt: params.endedAt,
    });

    // Keep the durable room snapshot/unread state in lockstep with the row.
    await this.roomRepo
      .updateRoomOnNewMessage({
        roomId: room.roomId,
        message: {
          _id: message.id,
          content: message.content,
          senderId,
          messageType,
          systemEvent,
          systemData,
          createdAt: message.createdAt,
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

    const callerSnapshot = isEnded
      ? { displayName: "", avatarUrl: "" }
      : await this.getUserSnapshot(params.callerId).catch(() => ({
          displayName: "",
          avatarUrl: "",
        }));
    const serverTs = message.createdAt.getTime();
    const wire = buildChatMessageEvent({
      id: message.id,
      clientMessageId,
      roomId: room.roomId,
      conversationType: "PRIVATE",
      senderId,
      senderName: callerSnapshot.displayName,
      senderAvatar: callerSnapshot.avatarUrl,
      receiverId,
      messageType,
      content: message.content,
      reactions: [],
      serverTs,
      sequenceNumber,
      countInUnread,
      systemEvent: systemEvent ?? undefined,
      systemData: systemData ?? undefined,
    });

    await this.redis
      .publish(
        `conv:${room.roomId}`,
        JSON.stringify({ event: "message:new", data: wire })
      )
      .catch((error: unknown) => {
        logger.warn(
          `CallChatMessageService|post|message:new publish failed callId=${params.callId}: ${String(error)}`
        );
      });

    publishConvUpdatedSafe({
      redis: this.redis,
      type: "PRIVATE",
      roomId: room.roomId,
      recipientIds: [params.callerId, params.calleeId],
      senderId,
      senderName: callerSnapshot.displayName,
      lastMessageId: message.id,
      lastMessageAt: serverTs,
      preview: { contentType: messageType, text },
      countInUnread,
      getIsOnline: this.getIsOnline,
    });

    if (!isEnded) {
      publishMessageSentSafe({
        conversationId: room.roomId,
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

    return message;
  }
}
