import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { env } from "../../config/env.js";
import { makeBreaker, makeGrpcCall } from "@aimess/grpc-utils";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(
  __dirname,
  "../../../../../packages/grpc-contracts/proto/messaging.proto"
);

export interface SendMessageParams {
  conversationId: string;
  senderId: string;
  clientMessageId?: string;
  contentType: string;
  contentText?: string;
  mediaKey?: string;
  contentJson?: string;
  repliedToId?: string;
  conversationType?: string;
  receiverId?: string;
  senderName?: string;
  senderAvatar?: string;
  /** §5.1: client compose time (epoch ms), display-only. */
  clientTs?: number;
}
export interface SendMessageResult {
  messageId: string;
  conversationId: string;
  sentAt: number;
  alreadySent: boolean;
  // int64 on the wire arrives as a STRING (proto-loader longs:String); coerce.
  sequenceNumber: number;
}
export interface GetConversationMessagesParams {
  conversationId: string;
  requesterId: string;
  cursor?: string;
  limit?: number;
  conversationType?: string;
}
export interface GetConversationMessagesResponse {
  messages: MessageDto[];
  nextCursor: string;
  hasMore: boolean;
}
export interface MessageDto {
  messageId: string;
  conversationId: string;
  senderId: string;
  contentType: string;
  contentText: string;
  mediaKey: string;
  contentJson: string;
  repliedToId: string;
  sentAt: number;
  /** @deprecated thin shape kept for back-compat; use reactionGroups. */
  reactions: { userId: string; emoji: string }[];
  /** Canonical grouped reactions (FE reads this). */
  reactionGroups: ReactionGroupDto[];
  isRead: boolean;
  sequenceNumber: number;
}
export interface MarkMessagesReadParams {
  conversationId: string;
  readerId: string;
  upToMessageId: string;
  conversationType?: string;
}
export interface EditMessageParams {
  messageId: string;
  conversationId: string;
  editorId: string;
  contentText?: string;
  contentJson?: string;
  conversationType?: string;
}
export interface EditMessageResult {
  messageId: string;
  editedAt: number;
  contentJson: string;
  sequenceNumber: number;
}
export interface MarkDeliveredParams {
  conversationId: string;
  recipientId: string;
  upToMessageId: string;
  conversationType?: string;
}
export interface MarkDeliveredResult {
  updatedCount: number;
}
export interface PresenceConnectParams {
  userId: string;
  deviceId: string;
  platform?: string;
  clientType?: string;
  appState?: string;
}
export interface PresenceDisconnectParams {
  userId: string;
  deviceId: string;
}
export interface PresenceHeartbeatParams {
  userId: string;
  deviceId: string;
  appState?: string;
}
export interface PresenceAck {
  ok: boolean;
}
export interface SendReactionParams {
  messageId: string;
  conversationId: string;
  userId: string;
  emoji: string;
  /** §2.4: route group reactions to the group collection (default private). */
  conversationType?: string;
  /** "set" => caller ends up with exactly `emoji`; default "toggle" is the legacy per-emoji flip. */
  mode?: string;
}
export interface SendReactionResult {
  messageId: string;
  reactions: { userId: string; emoji: string }[];
}

export interface ForwardMessageParams {
  messageId: string;
  targetConversationId: string;
  senderId: string;
  receiverId?: string;
  clientMessageId: string;
  conversationType?: string;
  senderName?: string;
  senderAvatar?: string;
}
export interface ForwardMessageResult {
  messageId: string;
  conversationId: string;
  sentAt: number;
  sequenceNumber: number;
}

export interface DeleteMessageParams {
  conversationId: string;
  messageId: string;
  userId: string;
  /** "forMe" | "forEveryone" */
  deleteType?: string;
  conversationType?: string;
}
export interface DeleteMessageResult {
  messageId: string;
  conversationId: string;
  deleteType: string;
}

export interface PinMessageParams {
  conversationId: string;
  messageId: string;
  userId: string;
  conversationType?: string;
}
export interface PinMessageResult {
  messageId: string;
  conversationId: string;
  pinnedCount: number;
  pinnedAt: number;
}

export interface UnpinMessageParams {
  conversationId: string;
  messageId: string;
  userId: string;
  conversationType?: string;
}
export interface UnpinMessageResult {
  messageId: string;
  conversationId: string;
  pinnedCount: number;
}

export interface CatchupRoomParams {
  conversationId: string;
  requesterId: string;
  sinceSeq: number;
  limit: number;
  conversationType: string;
  /** ZERO-LOSS revision cursor. Omit to stay on the legacy sinceSeq axis — the
   *  client sends the -1 "not revision mode" sentinel, since 0 is a valid cold start. */
  sinceRevision?: number;
}
export interface CatchupEventDto {
  messageId: string;
  conversationId: string;
  senderId: string;
  contentType: string;
  contentText: string;
  contentJson: string;
  sentAt: number;
  sequenceNumber: number;
  isDeleted: boolean;
  deletedType: string;
  editedAt: number;
  systemEvent: string;
  systemData: string;
  /** Per-message CHANGE cursor (Telegram pts). 0 when the row predates the backfill. */
  revision?: number;
  /** Canonical grouped reaction state — see CatchupEventDto.reactions in messaging.proto. */
  reactions?: Array<{
    emoji: string;
    count: number;
    users: Array<{ userId: string; displayName: string; avatar: string }>;
  }>;
}
export interface CatchupRoomResult {
  conversationId: string;
  events: CatchupEventDto[];
  hasMore: boolean;
  lastSeq: number;
  authorized: boolean;
  /** Revision-mode fields — 0/false in sinceSeq mode. */
  roomRevision?: number;
  lastRevision?: number;
  resetRequired?: boolean;
}

/**
 * Typing-indicator roster for private/group. Mirrors community's
 * getCommunityActiveMemberIds — one call yields both the sender-membership
 * check and the direct-delivery recipient list.
 */
export interface GetRoomParticipantIdsParams {
  conversationId: string;
  conversationType?: string;
}
export interface GetRoomParticipantIdsResult {
  userIds: string[];
  /**
   * Subset of `userIds` currently under a moderation mute (GROUP only; always
   * empty for PRIVATE). Optional so a chat-service that predates the field
   * still type-checks — an absent list simply gates nobody.
   */
  mutedUserIds?: string[];
}

export interface GetMessageReactionsParams {
  messageId: string;
  conversationId: string;
  conversationType?: string;
  requesterId: string;
}
export interface ReactionUserDto {
  userId: string;
  displayName: string;
  avatar: string;
}
export interface ReactionGroupDto {
  emoji: string;
  count: number;
  users: ReactionUserDto[];
  selfReacted: boolean;
}
export interface GetMessageReactionsResult {
  messageId: string;
  reactions: ReactionGroupDto[];
}

export interface LiveKitCredentials {
  url: string;
  token: string;
}

export interface InitiateCallParams {
  callerId: string;
  calleeId: string;
  type?: string;
  privateRoomId?: string;
  /** GROUP call: set instead of calleeId — server resolves the ring roster. */
  groupId?: string;
}
export interface CallStatusResult {
  callId: string;
  status: string;
  livekit?: LiveKitCredentials;
}
export interface AnswerCallParams {
  callId: string;
  calleeId: string;
}
export interface DeclineCallParams {
  callId: string;
  calleeId: string;
}
export interface EndCallParams {
  callId: string;
  userId: string;
}
export interface EndCallResult {
  callId: string;
  status: string;
  durationSec: number;
}
export interface GetCallHistoryParams {
  userId: string;
  cursor?: string;
  limit?: number;
}
export interface CallDto {
  callId: string;
  callerId: string;
  calleeId: string;
  type: string;
  status: string;
  initiatedAt: number;
  answeredAt: number;
  endedAt: number;
  durationSec: number;
  endedBy: string;
}
export interface GetCallHistoryResult {
  calls: CallDto[];
  nextCursor: string;
  hasMore: boolean;
}

export interface MessagingClient {
  sendMessage(p: SendMessageParams): Promise<SendMessageResult>;
  getConversationMessages(
    p: GetConversationMessagesParams
  ): Promise<GetConversationMessagesResponse>;
  markMessagesRead(
    p: MarkMessagesReadParams
  ): Promise<{ updatedCount: number }>;
  editMessage(p: EditMessageParams): Promise<EditMessageResult>;
  markDelivered(p: MarkDeliveredParams): Promise<MarkDeliveredResult>;
  presenceConnect(p: PresenceConnectParams): Promise<PresenceAck>;
  presenceDisconnect(p: PresenceDisconnectParams): Promise<PresenceAck>;
  presenceHeartbeat(p: PresenceHeartbeatParams): Promise<PresenceAck>;
  sendReaction(p: SendReactionParams): Promise<SendReactionResult>;
  forwardMessage(p: ForwardMessageParams): Promise<ForwardMessageResult>;
  deleteMessage(p: DeleteMessageParams): Promise<DeleteMessageResult>;
  pinMessage(p: PinMessageParams): Promise<PinMessageResult>;
  unpinMessage(p: UnpinMessageParams): Promise<UnpinMessageResult>;
  getMessageReactions(
    p: GetMessageReactionsParams
  ): Promise<GetMessageReactionsResult>;
  initiateCall(p: InitiateCallParams): Promise<CallStatusResult>;
  answerCall(p: AnswerCallParams): Promise<CallStatusResult>;
  declineCall(p: DeclineCallParams): Promise<CallStatusResult>;
  endCall(p: EndCallParams): Promise<EndCallResult>;
  getCallHistory(p: GetCallHistoryParams): Promise<GetCallHistoryResult>;
  handleLiveKitRoomFinished(p: {
    roomName: string;
    eventType: string;
  }): Promise<unknown>;
  catchupRoom(p: CatchupRoomParams): Promise<CatchupRoomResult>;
  getRoomParticipantIds(
    p: GetRoomParticipantIdsParams
  ): Promise<GetRoomParticipantIdsResult>;
}

export function createMessagingClient(): MessagingClient {
  const pkgDef = protoLoader.loadSync(PROTO_PATH, {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const proto = grpc.loadPackageDefinition(pkgDef) as grpc.GrpcObject;
  const ServiceCtor = (proto["messaging"] as grpc.GrpcObject)[
    "MessagingService"
  ] as grpc.ServiceClientConstructor;

  const client = new ServiceCtor(
    env.CHAT_GRPC_URL,
    grpc.credentials.createInsecure()
  );

  const call = <TReq, TRes>(method: string, req: TReq) =>
    makeGrpcCall<TReq, TRes>(client, method, req);

  const sendMessageBreaker = makeBreaker(
    "messaging.sendMessage",
    (p: SendMessageParams) => {
      const conversationType = String(
        p.conversationType ?? "private"
      ).toUpperCase();
      return call<unknown, SendMessageResult>("sendMessage", {
        conversationId: p.conversationId,
        senderId: p.senderId,
        clientMessageId: p.clientMessageId,
        contentType: p.contentType,
        contentText: p.contentText ?? "",
        mediaKey: p.mediaKey ?? "",
        contentJson: p.contentJson ?? "",
        repliedToId: p.repliedToId ?? "",
        conversationType: conversationType === "GROUP" ? "GROUP" : "PRIVATE",
        receiverId: p.receiverId ?? "",
        senderName: p.senderName ?? "",
        senderAvatar: p.senderAvatar ?? "",
        clientTs: p.clientTs ?? 0,
        // int64 `sentAt` + `sequenceNumber` arrive as strings (proto-loader
        // longs:String); coerce BOTH so the relayed ack matches the declared
        // `number` types and is identical to the `message:new` broadcast.
      }).then((r) => ({
        ...r,
        sentAt: Number(r.sentAt),
        sequenceNumber: Number(r.sequenceNumber),
      }));
    }
  );

  const getMessagesBreaker = makeBreaker(
    "messaging.getConversationMessages",
    (p: GetConversationMessagesParams) => {
      const conversationType = String(
        p.conversationType ?? "private"
      ).toUpperCase();
      return call<unknown, GetConversationMessagesResponse>(
        "getConversationMessages",
        {
          conversationId: p.conversationId,
          requesterId: p.requesterId,
          cursor: p.cursor ?? "",
          limit: p.limit ?? 30,
          conversationType: conversationType === "GROUP" ? "GROUP" : "PRIVATE",
        }
      ).then((r) => ({
        ...r,
        // int64 `sentAt` + `sequenceNumber` arrive as strings (proto-loader
        // longs:String); coerce both to numbers.
        messages: r.messages.map((m) => ({
          ...m,
          sentAt: Number(m.sentAt),
          sequenceNumber: Number(m.sequenceNumber),
        })),
      }));
    }
  );

  const markReadBreaker = makeBreaker(
    "messaging.markMessagesRead",
    (p: MarkMessagesReadParams) => {
      // Prefer the room-id prefix over a missing/default claim — same rule as
      // chat-service resolveConversationType. Prevents group opens from being
      // routed through the private mark-read path when the client omits type.
      const claimed = String(p.conversationType ?? "").toUpperCase();
      const fromId = String(p.conversationId ?? "").startsWith("grp_")
        ? "GROUP"
        : String(p.conversationId ?? "").startsWith("prv_")
          ? "PRIVATE"
          : claimed === "GROUP"
            ? "GROUP"
            : "PRIVATE";
      return call<unknown, { updatedCount: number }>("markMessagesRead", {
        conversationId: p.conversationId,
        readerId: p.readerId,
        upToMessageId: p.upToMessageId,
        conversationType: fromId,
      });
    }
  );

  const editMessageBreaker = makeBreaker(
    "messaging.editMessage",
    (p: EditMessageParams) => {
      const conversationType = String(
        p.conversationType ?? "private"
      ).toUpperCase();
      return call<unknown, EditMessageResult>("editMessage", {
        messageId: p.messageId,
        conversationId: p.conversationId,
        editorId: p.editorId,
        contentText: p.contentText ?? "",
        contentJson: p.contentJson ?? "",
        conversationType: conversationType === "GROUP" ? "GROUP" : "PRIVATE",
        // int64 `editedAt` + `sequenceNumber` arrive as strings; coerce both.
      }).then((r) => ({
        ...r,
        editedAt: Number(r.editedAt),
        sequenceNumber: Number(r.sequenceNumber),
      }));
    }
  );

  const markDeliveredBreaker = makeBreaker(
    "messaging.markDelivered",
    (p: MarkDeliveredParams) => {
      const conversationType = String(
        p.conversationType ?? "private"
      ).toUpperCase();
      return call<unknown, MarkDeliveredResult>("markDelivered", {
        conversationId: p.conversationId,
        recipientId: p.recipientId,
        upToMessageId: p.upToMessageId,
        conversationType: conversationType === "GROUP" ? "GROUP" : "PRIVATE",
      });
    }
  );

  const presenceConnectBreaker = makeBreaker(
    "messaging.presenceConnect",
    (p: PresenceConnectParams) =>
      call<unknown, PresenceAck>("presenceConnect", {
        userId: p.userId,
        deviceId: p.deviceId,
        platform: p.platform ?? "unknown",
        clientType: p.clientType ?? "unknown",
        appState: p.appState ?? "FOREGROUND",
      })
  );

  const presenceDisconnectBreaker = makeBreaker(
    "messaging.presenceDisconnect",
    (p: PresenceDisconnectParams) =>
      call<unknown, PresenceAck>("presenceDisconnect", {
        userId: p.userId,
        deviceId: p.deviceId,
      })
  );

  const presenceHeartbeatBreaker = makeBreaker(
    "messaging.presenceHeartbeat",
    (p: PresenceHeartbeatParams) =>
      call<unknown, PresenceAck>("presenceHeartbeat", {
        userId: p.userId,
        deviceId: p.deviceId,
        appState: p.appState ?? "FOREGROUND",
      })
  );

  const sendReactionBreaker = makeBreaker(
    "messaging.sendReaction",
    (p: SendReactionParams) => {
      const conversationType = String(
        p.conversationType ?? "private"
      ).toUpperCase();
      return call<unknown, SendReactionResult>("sendReaction", {
        messageId: p.messageId,
        conversationId: p.conversationId,
        userId: p.userId,
        emoji: p.emoji,
        conversationType: conversationType === "GROUP" ? "GROUP" : "PRIVATE",
        mode: String(p.mode ?? "").toLowerCase() === "set" ? "set" : "toggle",
      });
    }
  );

  const forwardMessageBreaker = makeBreaker(
    "messaging.forwardMessage",
    (p: ForwardMessageParams) => {
      const conversationType = String(
        p.conversationType ?? "private"
      ).toUpperCase();
      return call<unknown, ForwardMessageResult>("forwardMessage", {
        messageId: p.messageId,
        targetConversationId: p.targetConversationId,
        senderId: p.senderId,
        receiverId: p.receiverId ?? "",
        clientMessageId: p.clientMessageId,
        conversationType: conversationType === "GROUP" ? "GROUP" : "PRIVATE",
        senderName: p.senderName ?? "",
        senderAvatar: p.senderAvatar ?? "",
        // int64 `sentAt` + `sequenceNumber` arrive as strings; coerce both.
      }).then((r) => ({
        ...r,
        sentAt: Number(r.sentAt),
        sequenceNumber: Number(r.sequenceNumber),
      }));
    }
  );

  const deleteMessageBreaker = makeBreaker(
    "messaging.deleteMessage",
    (p: DeleteMessageParams) => {
      const conversationType = String(
        p.conversationType ?? "private"
      ).toUpperCase();
      return call<unknown, DeleteMessageResult>("deleteMessage", {
        conversationId: p.conversationId,
        messageId: p.messageId,
        userId: p.userId,
        deleteType: p.deleteType ?? "forMe",
        conversationType: conversationType === "GROUP" ? "GROUP" : "PRIVATE",
      });
    }
  );

  const pinMessageBreaker = makeBreaker(
    "messaging.pinMessage",
    (p: PinMessageParams) => {
      const conversationType = String(
        p.conversationType ?? "private"
      ).toUpperCase();
      return call<unknown, PinMessageResult>("pinMessage", {
        conversationId: p.conversationId,
        messageId: p.messageId,
        userId: p.userId,
        conversationType: conversationType === "GROUP" ? "GROUP" : "PRIVATE",
      }).then((r) => ({
        ...r,
        pinnedCount: Number(r.pinnedCount),
        pinnedAt: Number(r.pinnedAt),
      }));
    }
  );

  const unpinMessageBreaker = makeBreaker(
    "messaging.unpinMessage",
    (p: UnpinMessageParams) => {
      const conversationType = String(
        p.conversationType ?? "private"
      ).toUpperCase();
      return call<unknown, UnpinMessageResult>("unpinMessage", {
        conversationId: p.conversationId,
        messageId: p.messageId,
        userId: p.userId,
        conversationType: conversationType === "GROUP" ? "GROUP" : "PRIVATE",
      }).then((r) => ({
        ...r,
        pinnedCount: Number(r.pinnedCount),
      }));
    }
  );

  const getMessageReactionsBreaker = makeBreaker(
    "messaging.getMessageReactions",
    (p: GetMessageReactionsParams) => {
      const conversationType = String(
        p.conversationType ?? "private"
      ).toUpperCase();
      return call<unknown, GetMessageReactionsResult>("getMessageReactions", {
        messageId: p.messageId,
        conversationId: p.conversationId,
        conversationType: conversationType === "GROUP" ? "GROUP" : "PRIVATE",
        requesterId: p.requesterId,
      });
    }
  );

  const initiateCallBreaker = makeBreaker(
    "messaging.initiateCall",
    (p: InitiateCallParams) =>
      call<unknown, CallStatusResult>("initiateCall", {
        callerId: p.callerId,
        calleeId: p.calleeId ?? "",
        type: p.type ?? "AUDIO",
        privateRoomId: p.privateRoomId ?? "",
        groupId: p.groupId ?? "",
      })
  );

  const answerCallBreaker = makeBreaker(
    "messaging.answerCall",
    (p: AnswerCallParams) =>
      call<unknown, CallStatusResult>("answerCall", {
        callId: p.callId,
        calleeId: p.calleeId,
      })
  );

  const declineCallBreaker = makeBreaker(
    "messaging.declineCall",
    (p: DeclineCallParams) =>
      call<unknown, CallStatusResult>("declineCall", {
        callId: p.callId,
        calleeId: p.calleeId,
      })
  );

  const endCallBreaker = makeBreaker("messaging.endCall", (p: EndCallParams) =>
    call<unknown, EndCallResult>("endCall", {
      callId: p.callId,
      userId: p.userId,
    })
  );

  const getCallHistoryBreaker = makeBreaker(
    "messaging.getCallHistory",
    (p: GetCallHistoryParams) =>
      call<unknown, GetCallHistoryResult>("getCallHistory", {
        userId: p.userId,
        cursor: p.cursor ?? "",
        limit: p.limit ?? 20,
        // int64 initiated_at/answered_at/ended_at arrive as strings (proto-loader
        // longs:String); coerce each call's epoch-ms timestamps to numbers.
        // duration_sec is int32 → already a number, no coercion needed.
      }).then((r) => ({
        ...r,
        calls: r.calls.map((c) => ({
          ...c,
          initiatedAt: Number(c.initiatedAt),
          answeredAt: Number(c.answeredAt),
          endedAt: Number(c.endedAt),
        })),
      }))
  );

  const handleLiveKitRoomFinishedBreaker = makeBreaker(
    "messaging.handleLiveKitRoomFinished",
    (p: { roomName: string; eventType: string }) =>
      call<unknown, Record<string, never>>("handleLiveKitRoomFinished", {
        roomName: p.roomName,
        eventType: p.eventType,
      })
  );

  const catchupRoomBreaker = makeBreaker(
    "messaging.catchupRoom",
    (p: CatchupRoomParams) => {
      const conversationType = String(
        p.conversationType ?? "private"
      ).toUpperCase();
      return call<unknown, CatchupRoomResult>("catchupRoom", {
        conversationId: p.conversationId,
        requesterId: p.requesterId,
        sinceSeq: p.sinceSeq,
        limit: p.limit,
        conversationType: conversationType === "GROUP" ? "GROUP" : "PRIVATE",
        // -1 = client did not opt into revision mode (0 IS a valid cold start).
        sinceRevision: p.sinceRevision ?? -1,
      });
    }
  );

  const getRoomParticipantIdsBreaker = makeBreaker(
    "messaging.getRoomParticipantIds",
    (p: GetRoomParticipantIdsParams) =>
      call<unknown, GetRoomParticipantIdsResult>("getRoomParticipantIds", {
        conversationId: p.conversationId,
        conversationType:
          String(p.conversationType ?? "private").toUpperCase() === "GROUP"
            ? "GROUP"
            : "PRIVATE",
      })
  );

  return {
    sendMessage: (p) => sendMessageBreaker.fire(p),
    getConversationMessages: (p) => getMessagesBreaker.fire(p),
    markMessagesRead: (p) => markReadBreaker.fire(p),
    editMessage: (p) => editMessageBreaker.fire(p),
    markDelivered: (p) => markDeliveredBreaker.fire(p),
    presenceConnect: (p) => presenceConnectBreaker.fire(p),
    presenceDisconnect: (p) => presenceDisconnectBreaker.fire(p),
    presenceHeartbeat: (p) => presenceHeartbeatBreaker.fire(p),
    sendReaction: (p) => sendReactionBreaker.fire(p),
    forwardMessage: (p) => forwardMessageBreaker.fire(p),
    deleteMessage: (p) => deleteMessageBreaker.fire(p),
    pinMessage: (p) => pinMessageBreaker.fire(p),
    unpinMessage: (p) => unpinMessageBreaker.fire(p),
    getMessageReactions: (p) => getMessageReactionsBreaker.fire(p),
    initiateCall: (p) => initiateCallBreaker.fire(p),
    answerCall: (p) => answerCallBreaker.fire(p),
    declineCall: (p) => declineCallBreaker.fire(p),
    endCall: (p) => endCallBreaker.fire(p),
    getCallHistory: (p) => getCallHistoryBreaker.fire(p),
    handleLiveKitRoomFinished: (p) => handleLiveKitRoomFinishedBreaker.fire(p),
    catchupRoom: (p) => catchupRoomBreaker.fire(p),
    getRoomParticipantIds: (p) => getRoomParticipantIdsBreaker.fire(p),
  };
}
