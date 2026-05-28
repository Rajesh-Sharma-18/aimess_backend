import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { logger } from "@aimess/logger";
import { redis } from "../config/redis.js";
import type { PrivateMessageService } from "../services/private-message.service.js";
import type { GroupMessageService } from "../services/group-message.service.js";
import type { CacheRepository } from "../repositories/cache.repository.js";
import type { UserSnapshotService } from "../services/user-snapshot.service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(
  __dirname,
  "../../../../packages/grpc-contracts/proto/messaging.proto"
);

export interface GrpcDeps {
  privateMessageService: PrivateMessageService;
  groupMessageService: GroupMessageService;
  cacheRepo: CacheRepository;
  userSnapshotService: UserSnapshotService;
}

function parseMessageContent(req: {
  contentJson?: string;
  contentText?: string;
  mediaKey?: string;
}): {
  text: string;
  urls: string[];
  files: Array<Record<string, unknown>>;
  [key: string]: unknown;
} {
  const fallback = {
    text: req.contentText || "",
    urls: [] as string[],
    files: req.mediaKey ? [{ objectKey: req.mediaKey }] : [],
  };

  if (!req.contentJson) return fallback;

  try {
    const parsed = JSON.parse(req.contentJson) as Record<string, unknown>;
    return {
      text: typeof parsed.text === "string" ? parsed.text : fallback.text,
      urls: Array.isArray(parsed.urls) ? (parsed.urls as string[]) : [],
      files: Array.isArray(parsed.files)
        ? (parsed.files as Array<Record<string, unknown>>)
        : fallback.files,
      ...(parsed.location ? { location: parsed.location } : {}),
      ...(parsed.contact ? { contact: parsed.contact } : {}),
    };
  } catch {
    return fallback;
  }
}

function stringifyContent(content: unknown): string {
  try {
    return JSON.stringify(content ?? {});
  } catch {
    return "{}";
  }
}

export function startGrpcServer(port: number, deps: GrpcDeps): grpc.Server {
  const pkgDef = protoLoader.loadSync(PROTO_PATH, {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const proto = grpc.loadPackageDefinition(pkgDef) as grpc.GrpcObject;
  const MessagingService = (proto["messaging"] as grpc.GrpcObject)[
    "MessagingService"
  ] as unknown as grpc.ServiceClientConstructor;

  const messagingImpl: grpc.UntypedServiceImplementation = {
    sendMessage: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as {
            conversationId: string;
            senderId: string;
            receiverId: string;
            contentText: string;
            contentType: string;
            mediaKey: string;
            contentJson: string;
            repliedToId: string;
            clientMessageId: string;
            conversationType: string;
            senderName: string;
            senderAvatar: string;
          };

          let msg: {
            id: string;
            messageType: string;
            content: unknown;
            createdAt: unknown;
          };

          const conversationType = String(
            req.conversationType ?? ""
          ).toUpperCase();
          const content = parseMessageContent(req);
          if (conversationType === "GROUP") {
            msg = await deps.groupMessageService.sendMessage({
              roomId: req.conversationId,
              senderId: req.senderId,
              senderName: req.senderName || "",
              senderAvatar: req.senderAvatar || "",
              content,
              messageType: req.contentType || "TEXT",
              parentMessageId: req.repliedToId || null,
              clientMessageId: req.clientMessageId || null,
            });
          } else {
            msg = await deps.privateMessageService.sendMessage({
              roomId: req.conversationId,
              senderId: req.senderId,
              receiverId: req.receiverId,
              content,
              messageType: req.contentType || "TEXT",
              parentMessageId: req.repliedToId || null,
            });
          }

          await redis.publish(
            `conv:${req.conversationId}`,
            JSON.stringify({
              event: "message:new",
              data: {
                messageId: msg.id,
                conversationId: req.conversationId,
                senderId: req.senderId,
                contentType: msg.messageType,
                contentText:
                  ((msg.content as Record<string, unknown>)?.text as string) ??
                  "",
                contentJson: stringifyContent(msg.content),
                sentAt:
                  msg.createdAt instanceof Date
                    ? msg.createdAt.getTime()
                    : Date.now(),
              },
            })
          );

          callback(null, {
            messageId: msg.id,
            conversationId: req.conversationId,
            sentAt:
              msg.createdAt instanceof Date
                ? msg.createdAt.getTime()
                : Date.now(),
          });
        } catch (err) {
          logger.error(`gRPC sendMessage error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },

    getConversationMessages: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as {
            conversationId: string;
            requesterId: string;
            cursor: string;
            limit: number;
            conversationType: string;
          };

          const conversationType = String(
            req.conversationType ?? ""
          ).toUpperCase();
          const limit = req.limit || 30;

          if (conversationType === "GROUP") {
            const messages = await deps.groupMessageService.getMessages({
              roomId: req.conversationId,
              userId: req.requesterId,
              cursor: req.cursor || undefined,
              limit,
            });

            callback(null, {
              messages: messages.map((m) => ({
                messageId: m.id,
                conversationId: req.conversationId,
                senderId: m.senderId,
                contentType: m.messageType,
                contentText:
                  ((m.content as Record<string, unknown>)?.text as string) ??
                  "",
                contentJson: stringifyContent(m.content),
                sentAt: m.createdAt instanceof Date ? m.createdAt.getTime() : 0,
                reactions: [],
                isRead: false,
              })),
              nextCursor:
                messages.length > 0
                  ? messages[messages.length - 1]!.createdAt instanceof Date
                    ? (
                        messages[messages.length - 1]!.createdAt as Date
                      ).toISOString()
                    : ""
                  : "",
              hasMore: messages.length >= limit,
            });
            return;
          }

          const messages = await deps.privateMessageService.getMessages({
            roomId: req.conversationId,
            userId: req.requesterId,
            cursor: req.cursor || undefined,
            limit,
          });
          const enriched =
            await deps.privateMessageService.enrichMessages(messages);

          callback(null, {
            messages: enriched.map((m) => ({
              messageId: m.id,
              conversationId: req.conversationId,
              senderId: m.senderId,
              contentType: m.messageType,
              contentText:
                ((m.content as Record<string, unknown>)?.text as string) ?? "",
              contentJson: stringifyContent(m.content),
              sentAt: m.createdAt instanceof Date ? m.createdAt.getTime() : 0,
              reactions: [],
              isRead: false,
            })),
            nextCursor:
              messages.length > 0
                ? messages[messages.length - 1]!.createdAt instanceof Date
                  ? (
                      messages[messages.length - 1]!.createdAt as Date
                    ).toISOString()
                  : ""
                : "",
            hasMore: messages.length >= limit,
          });
        } catch (err) {
          logger.error(`gRPC getConversationMessages error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },

    markMessagesRead: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as {
            conversationId: string;
            readerId: string;
            upToMessageId: string;
          };

          await deps.privateMessageService.markRead({
            roomId: req.conversationId,
            userId: req.readerId,
            lastMessageId: req.upToMessageId,
          });

          await redis.publish(
            `conv:${req.conversationId}`,
            JSON.stringify({
              event: "message:read",
              data: {
                conversationId: req.conversationId,
                readerId: req.readerId,
                upToMessageId: req.upToMessageId,
              },
            })
          );

          callback(null, { updatedCount: 1 });
        } catch (err) {
          logger.error(`gRPC markMessagesRead error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },

    sendReaction: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as {
            messageId: string;
            conversationId: string;
            userId: string;
            emoji: string;
          };

          // reactions shape: Record<emoji, Array<{userId, userName, avatar, memberId}>>
          const reactionsMap: Record<
            string,
            Array<{
              userId: string;
              userName: string;
              avatar: string;
              memberId: string;
            }>
          > = {
            [req.emoji]: [
              { userId: req.userId, userName: "", avatar: "", memberId: "" },
            ],
          };
          const msg = await deps.privateMessageService.react(
            req.messageId,
            reactionsMap
          );

          // Flatten stored reactions for the pub/sub broadcast
          const stored = (msg as Record<string, unknown>).reactions as
            | Record<string, Array<{ userId: string }>>
            | undefined;
          const reactions: Array<{ emoji: string; userId: string }> = [];
          if (stored && typeof stored === "object") {
            for (const [emoji, users] of Object.entries(stored)) {
              for (const u of users)
                reactions.push({ emoji, userId: u.userId });
            }
          }

          await redis.publish(
            `conv:${req.conversationId}`,
            JSON.stringify({
              event: "message:reaction",
              data: {
                messageId: req.messageId,
                conversationId: req.conversationId,
                reactions,
              },
            })
          );

          callback(null, {
            messageId: req.messageId,
            reactions: reactions.map((r) => ({
              userId: r.userId,
              emoji: r.emoji,
            })),
          });
        } catch (err) {
          logger.error(`gRPC sendReaction error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },
  };

  const server = new grpc.Server();
  server.addService(MessagingService.service, messagingImpl);

  server.bindAsync(
    `0.0.0.0:${port}`,
    grpc.ServerCredentials.createInsecure(),
    (err, boundPort) => {
      if (err) {
        logger.error(`chat-service gRPC failed to bind: ${err.message}`);
        return;
      }
      logger.info(`chat-service gRPC server listening on port ${boundPort}`);
    }
  );

  return server;
}
