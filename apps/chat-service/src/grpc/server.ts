import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { logger } from "@aimess/logger";
import { redis } from "../config/redis.js";
import type { PrivateMessageService } from "../services/private-message.service.js";
import type { GroupMessageService } from "../services/group-message.service.js";
import type { GroupMemberService } from "../services/group-member.service.js";
import type { CacheRepository } from "../repositories/cache.repository.js";
import type { UserSnapshotService } from "../services/user-snapshot.service.js";
import type { CallService } from "../services/call.service.js";
import type { WebRtcConfigService } from "../services/webrtc-config.service.js";
import type { PresenceService } from "../services/presence.service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(
  __dirname,
  "../../../../packages/grpc-contracts/proto/messaging.proto"
);

export interface GrpcDeps {
  privateMessageService: PrivateMessageService;
  groupMessageService: GroupMessageService;
  groupMemberService: GroupMemberService;
  cacheRepo: CacheRepository;
  userSnapshotService: UserSnapshotService;
  callService: CallService;
  webRtcConfigService: WebRtcConfigService;
  presenceService: PresenceService;
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
          // Track whether this was an idempotency hit (message already existed).
          // Set by comparing createdAt to now after the service call.
          let alreadySent = false;

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
              clientMessageId: req.clientMessageId || null,
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

          // Detect idempotency hit: message created more than 5s ago → already existed
          if (
            msg.createdAt instanceof Date &&
            Date.now() - msg.createdAt.getTime() > 5000
          ) {
            alreadySent = true;
          }

          callback(null, {
            messageId: msg.id,
            conversationId: req.conversationId,
            sentAt:
              msg.createdAt instanceof Date
                ? msg.createdAt.getTime()
                : Date.now(),
            alreadySent,
          });
        } catch (err) {
          logger.error(`gRPC sendMessage error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },

    editMessage: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as {
            messageId: string;
            conversationId: string;
            editorId: string;
            contentText?: string;
            contentJson?: string;
            conversationType?: string;
          };

          const conversationType =
            typeof req.conversationType === "string"
              ? req.conversationType.toUpperCase()
              : "PRIVATE";

          if (conversationType === "GROUP") {
            callback({
              code: grpc.status.UNIMPLEMENTED,
              message: "EditMessage not supported for GROUP conversations",
            });
            return;
          }

          const content = parseMessageContent(req);
          const updated = await deps.privateMessageService.editMessage({
            messageId: req.messageId,
            userId: req.editorId,
            content,
          });

          const editedAtMs =
            updated.editedAt instanceof Date
              ? updated.editedAt.getTime()
              : Date.now();
          const contentJson = stringifyContent(updated.content);

          await redis.publish(
            `conv:${req.conversationId}`,
            JSON.stringify({
              event: "message:edited",
              data: {
                messageId: updated.id,
                conversationId: req.conversationId,
                contentText:
                  ((updated.content as Record<string, unknown>)
                    ?.text as string) ?? "",
                contentJson,
                editedAt: editedAtMs,
              },
            })
          );

          callback(null, {
            messageId: updated.id,
            editedAt: editedAtMs,
            contentJson,
          });
        } catch (err) {
          logger.error(`gRPC editMessage error: ${String(err)}`);
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
            conversationType?: string;
          };

          const conversationType =
            typeof req.conversationType === "string"
              ? req.conversationType.toUpperCase()
              : "PRIVATE";

          if (conversationType === "GROUP") {
            await deps.groupMemberService.markRead({
              roomId: req.conversationId,
              userId: req.readerId,
              lastMessageId: req.upToMessageId,
            });
          } else {
            await deps.privateMessageService.markRead({
              roomId: req.conversationId,
              userId: req.readerId,
              lastMessageId: req.upToMessageId,
            });
          }

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

    markDelivered: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as {
            conversationId: string;
            recipientId: string;
            upToMessageId: string;
            conversationType?: string;
          };

          const conversationType =
            typeof req.conversationType === "string"
              ? req.conversationType.toUpperCase()
              : "PRIVATE";

          if (conversationType === "GROUP") {
            callback(null, { updatedCount: 0 });
            return;
          }

          const { count, messageIds } =
            await deps.privateMessageService.markDelivered({
              roomId: req.conversationId,
              recipientId: req.recipientId,
              upToMessageId: req.upToMessageId,
            });

          if (count > 0) {
            await redis.publish(
              `conv:${req.conversationId}`,
              JSON.stringify({
                event: "message:delivered",
                data: {
                  conversationId: req.conversationId,
                  recipientId: req.recipientId,
                  upToMessageId: req.upToMessageId,
                  messageIds,
                },
              })
            );
          }

          callback(null, { updatedCount: count });
        } catch (err) {
          logger.error(`gRPC markDelivered error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },

    presenceConnect: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as {
            userId: string;
            deviceId: string;
            platform?: string;
            clientType?: string;
            appState?: string;
          };
          await deps.presenceService.connect(req.userId, req.deviceId, {
            platform: req.platform || "unknown",
            clientType: req.clientType || "unknown",
            appState: req.appState || "FOREGROUND",
          });
          callback(null, { ok: true });
        } catch (err) {
          logger.error(`gRPC presenceConnect error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },

    presenceDisconnect: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as { userId: string; deviceId: string };
          await deps.presenceService.disconnect(req.userId, req.deviceId);
          callback(null, { ok: true });
        } catch (err) {
          logger.error(`gRPC presenceDisconnect error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },

    presenceHeartbeat: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as {
            userId: string;
            deviceId: string;
            appState?: string;
          };
          await deps.presenceService.heartbeat(
            req.userId,
            req.deviceId,
            req.appState || "FOREGROUND"
          );
          callback(null, { ok: true });
        } catch (err) {
          logger.error(`gRPC presenceHeartbeat error: ${String(err)}`);
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

    forwardMessage: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as {
            messageId?: string;
            targetConversationId?: string;
            senderId?: string;
            receiverId?: string;
            clientMessageId?: string;
            conversationType?: string;
            senderName?: string;
            senderAvatar?: string;
          };

          const conversationType =
            typeof req.conversationType === "string"
              ? req.conversationType.toUpperCase()
              : "PRIVATE";

          let message: { id: string; messageType: string; createdAt: Date };

          if (conversationType === "GROUP") {
            message = await deps.groupMessageService.forwardMessage({
              sourceMessageId: req.messageId ?? "",
              targetRoomId: req.targetConversationId ?? "",
              senderId: req.senderId ?? "",
              senderName: req.senderName ?? "",
              senderAvatar: req.senderAvatar ?? "",
              clientMessageId: req.clientMessageId ?? null,
            });
          } else {
            message = await deps.privateMessageService.forwardMessage({
              sourceMessageId: req.messageId ?? "",
              targetRoomId: req.targetConversationId ?? "",
              senderId: req.senderId ?? "",
              receiverId: req.receiverId ?? "",
              clientMessageId: req.clientMessageId ?? null,
            });
          }

          await redis.publish(
            `conv:${req.targetConversationId ?? ""}`,
            JSON.stringify({
              event: "message:new",
              data: {
                messageId: message.id,
                conversationId: req.targetConversationId,
                senderId: req.senderId,
                contentType: message.messageType,
                isForwarded: true,
              },
            })
          );

          callback(null, {
            messageId: message.id,
            conversationId: req.targetConversationId ?? "",
            sentAt: message.createdAt.getTime(),
          });
        } catch (err) {
          logger.error(`gRPC forwardMessage error: ${String(err)}`);
          callback({
            code: grpc.status.INTERNAL,
            message: String(err),
          });
        }
      })();
    },

    getMessageReactions: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as {
            messageId?: string;
            conversationId?: string;
            conversationType?: string;
            requesterId?: string;
          };

          const conversationType =
            typeof req.conversationType === "string"
              ? req.conversationType.toUpperCase()
              : "PRIVATE";

          const result =
            conversationType === "GROUP"
              ? await deps.groupMessageService.getMessageReactions({
                  messageId: req.messageId ?? "",
                  roomId: req.conversationId ?? "",
                  requesterId: req.requesterId ?? "",
                })
              : await deps.privateMessageService.getMessageReactions({
                  messageId: req.messageId ?? "",
                  roomId: req.conversationId ?? "",
                  requesterId: req.requesterId ?? "",
                });

          const reactionList = Object.entries(result.reactions).map(
            ([emoji, data]) => ({
              emoji,
              count: data.count,
              users: data.users,
              selfReacted: data.selfReacted,
            })
          );

          callback(null, {
            messageId: req.messageId ?? "",
            reactions: reactionList,
          });
        } catch (err) {
          logger.error(`gRPC getMessageReactions error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },

    initiateCall: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as {
            callerId?: string;
            calleeId?: string;
            type?: string;
            privateRoomId?: string;
          };
          const result = await deps.callService.initiateCall({
            callerId: req.callerId ?? "",
            calleeId: req.calleeId ?? "",
            type: req.type ?? "AUDIO",
            privateRoomId: req.privateRoomId ?? null,
          });

          const rtcConfig = deps.webRtcConfigService.getRtcConfiguration();
          callback(null, {
            callId: result.callId,
            status: result.status,
            rtcConfig: {
              iceServers: rtcConfig.iceServers.map((server) => ({
                urls: server.urls,
                username: server.username ?? "",
                credential: server.credential ?? "",
                credentialType: server.credentialType ?? "password",
              })),
              iceCandidatePoolSize: rtcConfig.iceCandidatePoolSize,
              iceTransportPolicy: rtcConfig.iceTransportPolicy,
            },
          });
        } catch (err) {
          logger.error(`gRPC initiateCall error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },

    answerCall: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as { callId?: string; calleeId?: string };
          const result = await deps.callService.answerCall({
            callId: req.callId ?? "",
            calleeId: req.calleeId ?? "",
          });
          callback(null, { callId: result.callId, status: result.status });
        } catch (err) {
          logger.error(`gRPC answerCall error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },

    declineCall: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as { callId?: string; calleeId?: string };
          const result = await deps.callService.declineCall({
            callId: req.callId ?? "",
            calleeId: req.calleeId ?? "",
          });
          callback(null, { callId: result.callId, status: result.status });
        } catch (err) {
          logger.error(`gRPC declineCall error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },

    endCall: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as { callId?: string; userId?: string };
          const result = await deps.callService.endCall({
            callId: req.callId ?? "",
            userId: req.userId ?? "",
          });
          callback(null, {
            callId: result.callId,
            status: result.status,
            durationSec: result.durationSec ?? 0,
          });
        } catch (err) {
          logger.error(`gRPC endCall error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },

    getCallHistory: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as {
            userId?: string;
            cursor?: string;
            limit?: number;
          };
          const result = await deps.callService.getCallHistory({
            userId: req.userId ?? "",
            cursor: req.cursor ?? null,
            limit: req.limit ?? 20,
          });
          callback(null, {
            calls: result.calls.map((c) => ({
              callId: c.callId,
              callerId: c.callerId,
              calleeId: c.calleeId,
              type: c.type,
              status: c.status,
              initiatedAt: c.initiatedAt.getTime(),
              answeredAt: c.answeredAt?.getTime() ?? 0,
              endedAt: c.endedAt?.getTime() ?? 0,
              durationSec: c.durationSec ?? 0,
              endedBy: c.endedBy ?? "",
            })),
            nextCursor: result.nextCursor ?? "",
            hasMore: result.hasMore,
          });
        } catch (err) {
          logger.error(`gRPC getCallHistory error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },

    getRtcConfig: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      try {
        const rtcConfig = deps.webRtcConfigService.getRtcConfiguration();
        callback(null, {
          rtcConfig: {
            iceServers: rtcConfig.iceServers.map((server) => ({
              urls: server.urls,
              username: server.username ?? "",
              credential: server.credential ?? "",
              credentialType: server.credentialType ?? "password",
            })),
            iceCandidatePoolSize: rtcConfig.iceCandidatePoolSize,
            iceTransportPolicy: rtcConfig.iceTransportPolicy,
          },
        });
      } catch (err) {
        logger.error(`gRPC getRtcConfig error: ${String(err)}`);
        callback({ code: grpc.status.INTERNAL, message: String(err) });
      }
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
