import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { env } from "../../config/env.js";
import {
  makeBreaker,
  makeBreakerNoArgs,
  makeGrpcCall,
} from "@aimess/grpc-utils";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(
  __dirname,
  "../../../../../packages/grpc-contracts/proto/messaging.proto"
);

export interface SendMessageParams {
  conversationId: string;
  senderId: string;
  clientMessageId: string;
  contentType: string;
  contentText?: string;
  mediaKey?: string;
  contentJson?: string;
  repliedToId?: string;
  conversationType?: string;
  receiverId?: string;
  senderName?: string;
  senderAvatar?: string;
}
export interface SendMessageResult {
  messageId: string;
  conversationId: string;
  sentAt: number;
  alreadySent: boolean;
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
  reactions: { userId: string; emoji: string }[];
  isRead: boolean;
}
export interface MarkMessagesReadParams {
  conversationId: string;
  readerId: string;
  upToMessageId: string;
  conversationType?: string;
}
export interface SendReactionParams {
  messageId: string;
  conversationId: string;
  userId: string;
  emoji: string;
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

export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
  credentialType?: string;
}

export interface RtcConfiguration {
  iceServers: IceServer[];
  iceCandidatePoolSize: number;
  iceTransportPolicy: string;
}

export interface GetRtcConfigResult {
  rtcConfig: RtcConfiguration;
}

export interface InitiateCallParams {
  callerId: string;
  calleeId: string;
  type?: string;
  privateRoomId?: string;
}
export interface CallStatusResult {
  callId: string;
  status: string;
  rtcConfig?: RtcConfiguration;
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
  sendReaction(p: SendReactionParams): Promise<SendReactionResult>;
  forwardMessage(p: ForwardMessageParams): Promise<ForwardMessageResult>;
  getMessageReactions(
    p: GetMessageReactionsParams
  ): Promise<GetMessageReactionsResult>;
  initiateCall(p: InitiateCallParams): Promise<CallStatusResult>;
  answerCall(p: AnswerCallParams): Promise<CallStatusResult>;
  declineCall(p: DeclineCallParams): Promise<CallStatusResult>;
  endCall(p: EndCallParams): Promise<EndCallResult>;
  getCallHistory(p: GetCallHistoryParams): Promise<GetCallHistoryResult>;
  getRtcConfig(): Promise<GetRtcConfigResult>;
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
    env.MESSAGING_GRPC_URL,
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
      });
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
      );
    }
  );

  const markReadBreaker = makeBreaker(
    "messaging.markMessagesRead",
    (p: MarkMessagesReadParams) => {
      const conversationType = String(
        p.conversationType ?? "private"
      ).toUpperCase();
      return call<unknown, { updatedCount: number }>("markMessagesRead", {
        conversationId: p.conversationId,
        readerId: p.readerId,
        upToMessageId: p.upToMessageId,
        conversationType: conversationType === "GROUP" ? "GROUP" : "PRIVATE",
      });
    }
  );

  const sendReactionBreaker = makeBreaker(
    "messaging.sendReaction",
    (p: SendReactionParams) =>
      call<unknown, SendReactionResult>("sendReaction", {
        messageId: p.messageId,
        conversationId: p.conversationId,
        userId: p.userId,
        emoji: p.emoji,
      })
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
      });
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
        calleeId: p.calleeId,
        type: p.type ?? "AUDIO",
        privateRoomId: p.privateRoomId ?? "",
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
      })
  );

  const getRtcConfigBreaker = makeBreakerNoArgs(
    "messaging.getRtcConfig",
    () => {
      return call<unknown, GetRtcConfigResult>("getRtcConfig", { userId: "" });
    }
  );

  return {
    sendMessage: (p) => sendMessageBreaker.fire(p),
    getConversationMessages: (p) => getMessagesBreaker.fire(p),
    markMessagesRead: (p) => markReadBreaker.fire(p),
    sendReaction: (p) => sendReactionBreaker.fire(p),
    forwardMessage: (p) => forwardMessageBreaker.fire(p),
    getMessageReactions: (p) => getMessageReactionsBreaker.fire(p),
    initiateCall: (p) => initiateCallBreaker.fire(p),
    answerCall: (p) => answerCallBreaker.fire(p),
    declineCall: (p) => declineCallBreaker.fire(p),
    endCall: (p) => endCallBreaker.fire(p),
    getCallHistory: (p) => getCallHistoryBreaker.fire(p),
    getRtcConfig: () => getRtcConfigBreaker.fire(),
  };
}
