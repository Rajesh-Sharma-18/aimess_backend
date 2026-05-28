import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import CircuitBreaker from "opossum";
import { logger } from "@aimess/logger";
import { env } from "../../config/env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(
  __dirname,
  "../../../../../packages/grpc-contracts/proto/messaging.proto"
);

const BREAKER_OPTS = {
  timeout: 2000,
  errorThresholdPercentage: 50,
  resetTimeout: 10000,
  volumeThreshold: 5,
};

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

export interface MessagingClient {
  sendMessage(p: SendMessageParams): Promise<SendMessageResult>;
  getConversationMessages(
    p: GetConversationMessagesParams
  ): Promise<GetConversationMessagesResponse>;
  markMessagesRead(
    p: MarkMessagesReadParams
  ): Promise<{ updatedCount: number }>;
  sendReaction(p: SendReactionParams): Promise<SendReactionResult>;
}

function makeBreaker<T, R>(
  name: string,
  fn: (p: T) => Promise<R>
): CircuitBreaker<[T], R> {
  const breaker = new CircuitBreaker(fn, { ...BREAKER_OPTS, name });
  breaker.fallback(() => {
    throw new Error(`${name} unavailable`);
  });
  breaker.on("open", () => logger.warn(`Circuit opened: ${name}`));
  breaker.on("halfOpen", () => logger.info(`Circuit half-open: ${name}`));
  return breaker;
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

  function call<TReq, TRes>(method: string, req: TReq): Promise<TRes> {
    return new Promise((resolve, reject) => {
      (
        client as unknown as Record<
          string,
          (
            r: TReq,
            cb: (e: grpc.ServiceError | null, res: TRes) => void
          ) => void
        >
      )[method](req, (err, res) => {
        if (err) reject(err);
        else resolve(res);
      });
    });
  }

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
    (p: MarkMessagesReadParams) =>
      call<unknown, { updatedCount: number }>("markMessagesRead", {
        conversationId: p.conversationId,
        readerId: p.readerId,
        upToMessageId: p.upToMessageId,
      })
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

  return {
    sendMessage: (p) => sendMessageBreaker.fire(p),
    getConversationMessages: (p) => getMessagesBreaker.fire(p),
    markMessagesRead: (p) => markReadBreaker.fire(p),
    sendReaction: (p) => sendReactionBreaker.fire(p),
  };
}
