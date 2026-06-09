import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { logger } from "@aimess/logger";
import { redis } from "../config/redis.js";
import { publishCommunityActivitySafe } from "../events/publish-community-activity.js";
import {
  publishConvUpdatedSafe,
  publishCommunityUpdatedSafe,
} from "../events/publish-conv-updated.js";
import {
  publishMessageSentSafe,
  buildPushPreview,
} from "../events/publish-message-sent.js";
import type { PrivateMessageService } from "../services/private-message.service.js";
import type { GroupMessageService } from "../services/group-message.service.js";
import type { GroupMemberService } from "../services/group-member.service.js";
import type { GroupRoomRepository } from "../repositories/group-room.repository.js";
import type { GroupMemberRepository } from "../repositories/group-member.repository.js";
import type { AdminGroupService } from "../services/admin-group.service.js";
import type { CacheRepository } from "../repositories/cache.repository.js";
import type { UserSnapshotService } from "../services/user-snapshot.service.js";
import type { CallService } from "../services/call.service.js";
import type { WebRtcConfigService } from "../services/webrtc-config.service.js";
import type { PresenceService } from "../services/presence.service.js";
import type { CommunityMessageService } from "../services/community-message.service.js";
import type { NotificationRepository } from "../repositories/notification.repository.js";
import {
  buildChatMessageEvent,
  groupStoredReactions,
  flattenStoredReactions,
  normalizeMessageType,
} from "../lib/chat-message.serializer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(
  __dirname,
  "../../../../packages/grpc-contracts/proto/messaging.proto"
);
const COMMUNITY_PROTO_PATH = path.resolve(
  __dirname,
  "../../../../packages/grpc-contracts/proto/community.proto"
);
const NOTIFICATION_PROTO_PATH = path.resolve(
  __dirname,
  "../../../../packages/grpc-contracts/proto/notification.proto"
);

export interface GrpcDeps {
  privateMessageService: PrivateMessageService;
  groupMessageService: GroupMessageService;
  groupMemberService: GroupMemberService;
  groupRoomRepo: GroupRoomRepository;
  groupMemberRepo: GroupMemberRepository;
  adminGroupService: AdminGroupService;
  cacheRepo: CacheRepository;
  userSnapshotService: UserSnapshotService;
  callService: CallService;
  webRtcConfigService: WebRtcConfigService;
  presenceService: PresenceService;
  communityMessageService: CommunityMessageService;
  notificationRepo: NotificationRepository;
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

/** Parse an admin filter date ("YYYY-MM-DD" or ISO); "" / invalid → undefined. */
function parseAdminDate(value?: string): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
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

  const communityPkgDef = protoLoader.loadSync(COMMUNITY_PROTO_PATH, {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const communityProto = grpc.loadPackageDefinition(
    communityPkgDef
  ) as grpc.GrpcObject;
  const CommunityService = (communityProto["community"] as grpc.GrpcObject)[
    "CommunityService"
  ] as unknown as grpc.ServiceClientConstructor;

  const notificationPkgDef = protoLoader.loadSync(NOTIFICATION_PROTO_PATH, {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const notificationProto = grpc.loadPackageDefinition(
    notificationPkgDef
  ) as grpc.GrpcObject;
  const NotificationGrpcService = (
    notificationProto["notification"] as grpc.GrpcObject
  )["NotificationService"] as unknown as grpc.ServiceClientConstructor;

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
            clientTs?: string | number;
          };

          // proto-loader delivers int64 client_ts as a STRING (longs: String).
          const clientTs = Number(req.clientTs ?? 0) || 0;

          let msg: {
            id: string;
            messageType: string;
            content: unknown;
            createdAt: unknown;
            sequenceNumber: number;
            senderRole?: string;
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
              clientTs,
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
              clientTs,
            });
          }

          {
            const serverTs =
              msg.createdAt instanceof Date
                ? msg.createdAt.getTime()
                : Date.now();
            const full = msg as Record<string, unknown>;
            await redis.publish(
              `conv:${req.conversationId}`,
              JSON.stringify({
                event: "message:new",
                data: buildChatMessageEvent({
                  id: msg.id,
                  clientMessageId: req.clientMessageId,
                  roomId: req.conversationId,
                  conversationType:
                    conversationType === "GROUP" ? "GROUP" : "PRIVATE",
                  senderId: req.senderId,
                  senderName: req.senderName,
                  senderAvatar: req.senderAvatar,
                  senderRole: msg.senderRole,
                  receiverId: req.receiverId,
                  messageType: msg.messageType,
                  content: msg.content ?? null,
                  parentMessageId: (full.parentMessageId as string) || "",
                  quoteData: full.quoteData ?? null,
                  reactions: [],
                  clientTs,
                  serverTs,
                  sequenceNumber: msg.sequenceNumber,
                }),
              })
            );
          }

          // Bump-to-top: fan out conv:updated to every participant's inbox.
          // Fire-and-forget — must never delay the send callback.
          {
            const bumpSentAt =
              msg.createdAt instanceof Date
                ? msg.createdAt.getTime()
                : Date.now();
            const bumpText =
              ((msg.content as Record<string, unknown>)?.text as string) ?? "";
            const bumpBase = {
              redis,
              type: (conversationType?.toUpperCase() === "GROUP"
                ? "GROUP"
                : "PRIVATE") as "GROUP" | "PRIVATE",
              roomId: req.conversationId,
              senderId: req.senderId,
              lastMessageId: msg.id,
              lastMessageAt: bumpSentAt,
              preview: { contentType: msg.messageType, text: bumpText },
            };
            if (conversationType === "GROUP") {
              publishConvUpdatedSafe({
                ...bumpBase,
                fetchRecipients: () =>
                  deps.groupMessageService.getActiveMemberIds(
                    req.conversationId
                  ),
              });
            } else {
              publishConvUpdatedSafe({
                ...bumpBase,
                recipientIds: [req.senderId, req.receiverId],
              });
            }
          }

          // Detect idempotency hit: message created more than 5s ago → already existed
          if (
            msg.createdAt instanceof Date &&
            Date.now() - msg.createdAt.getTime() > 5000
          ) {
            alreadySent = true;
          }

          // V2 §4: trigger an FCM/APNs push (fallback wake for app-killed
          // recipients) via notifications-service. Skipped on idempotent replays.
          // Fire-and-forget — never blocks the send callback. The sender is
          // excluded inside the publisher.
          if (!alreadySent) {
            const pushSentAt =
              msg.createdAt instanceof Date
                ? msg.createdAt.getTime()
                : Date.now();
            const pushText =
              ((msg.content as Record<string, unknown>)?.text as string) ?? "";
            const pushBase = {
              conversationId: req.conversationId,
              conversationType: (conversationType === "GROUP"
                ? "GROUP"
                : "PRIVATE") as "GROUP" | "PRIVATE",
              messageId: msg.id,
              clientMessageId: req.clientMessageId || "",
              senderId: req.senderId,
              senderName: req.senderName || "",
              senderAvatar: req.senderAvatar || "",
              preview: buildPushPreview(msg.messageType, pushText),
              messageType: msg.messageType,
              sentAt: pushSentAt,
            };
            if (conversationType === "GROUP") {
              publishMessageSentSafe({
                ...pushBase,
                fetchRecipients: () =>
                  deps.groupMessageService.getActiveMemberIds(
                    req.conversationId
                  ),
              });
            } else {
              publishMessageSentSafe({
                ...pushBase,
                recipientIds: [req.receiverId],
              });
            }
          }

          callback(null, {
            messageId: msg.id,
            conversationId: req.conversationId,
            sentAt:
              msg.createdAt instanceof Date
                ? msg.createdAt.getTime()
                : Date.now(),
            alreadySent,
            sequenceNumber: msg.sequenceNumber,
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
          const updatedFull = updated as Record<string, unknown>;

          // §9: message:edited carries the FULL canonical ChatMessage shape (not
          // a thin {contentText,contentJson}) so a client can re-render the bubble
          // with one mapper. Reactions are grouped from the stored map.
          await redis.publish(
            `conv:${req.conversationId}`,
            JSON.stringify({
              event: "message:edited",
              data: buildChatMessageEvent({
                id: updated.id,
                clientMessageId: (updatedFull.clientMessageId as string) ?? "",
                roomId: req.conversationId,
                conversationType: "PRIVATE",
                senderId: updated.senderId ?? "",
                receiverId: (updatedFull.receiverId as string) ?? "",
                messageType: updated.messageType,
                content: updated.content ?? null,
                parentMessageId: (updatedFull.parentMessageId as string) || "",
                quoteData: updatedFull.quoteData ?? null,
                reactions: groupStoredReactions(updatedFull.reactions),
                isDeleted: Boolean(updatedFull.isDeleted),
                editedAt: editedAtMs,
                clientTs: Number(
                  (updatedFull.clientInfo as Record<string, unknown> | null)
                    ?.clientTs ?? 0
                ),
                serverTs:
                  updated.createdAt instanceof Date
                    ? updated.createdAt.getTime()
                    : Date.now(),
                sequenceNumber: updated.sequenceNumber,
              }),
            })
          );

          callback(null, {
            messageId: updated.id,
            editedAt: editedAtMs,
            contentJson,
            sequenceNumber: updated.sequenceNumber,
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
                contentType: normalizeMessageType(m.messageType),
                contentText:
                  ((m.content as Record<string, unknown>)?.text as string) ??
                  "",
                contentJson: stringifyContent(m.content),
                sentAt: m.createdAt instanceof Date ? m.createdAt.getTime() : 0,
                reactions: flattenStoredReactions(
                  (m as Record<string, unknown>).reactions
                ),
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
              contentType: normalizeMessageType(m.messageType as string),
              contentText:
                ((m.content as Record<string, unknown>)?.text as string) ?? "",
              contentJson: stringifyContent(m.content),
              sentAt: m.createdAt instanceof Date ? m.createdAt.getTime() : 0,
              reactions: flattenStoredReactions(
                (m as Record<string, unknown>).reactions
              ),
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

          let readToSeq = 0;
          if (conversationType === "GROUP") {
            await deps.groupMemberService.markRead({
              roomId: req.conversationId,
              userId: req.readerId,
              lastMessageId: req.upToMessageId,
            });
            readToSeq = await deps.groupMessageService
              .getMessageSequence(req.upToMessageId)
              .catch(() => 0);
          } else {
            await deps.privateMessageService.markRead({
              roomId: req.conversationId,
              userId: req.readerId,
              lastMessageId: req.upToMessageId,
            });
            readToSeq = await deps.privateMessageService
              .getMessageSequence(req.upToMessageId)
              .catch(() => 0);
          }

          // Read receipt to the conversation room (V1, unchanged).
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

          // V2 §2.6/§5.5: read_sync to the reader's OWN other devices so their
          // unread badge clears too. Published to user:<readerId> (every device of
          // that user joins this room on connect). Fire-and-forget.
          void redis
            .publish(
              `user:${req.readerId}`,
              JSON.stringify({
                event: "read_sync",
                data: {
                  conversationId: req.conversationId,
                  readerId: req.readerId,
                  read_to_seq: readToSeq,
                  unreadCount: 0,
                  conversationType,
                },
              })
            )
            .catch((e: unknown) =>
              logger.warn(`read_sync publish failed: ${String(e)}`)
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
            conversationType?: string;
          };

          // §2.4: route group reactions to the group collection. The two services
          // expose identical react/getMessageReactions signatures.
          const reactConversationType = String(
            req.conversationType ?? ""
          ).toUpperCase();
          const reactionService =
            reactConversationType === "GROUP"
              ? deps.groupMessageService
              : deps.privateMessageService;

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
          const msg = await reactionService.react(req.messageId, reactionsMap);

          // Flatten stored reactions for the gRPC ack (V1 thin shape — the
          // ReactionDto proto carries {userId, emoji}; the gateway maps it).
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

          // V2 §2.4: broadcast the full ChatReactionGroup[] shape (emoji, count,
          // users[displayName+avatar]) so the live push renders the reaction bar
          // without a refetch. Reuse the snapshot-enriched grouping the REST/gRPC
          // getMessageReactions path already builds. `selfReacted` is intentionally
          // omitted from the broadcast — it is per-viewer, so each client derives
          // it from users[].userId === myUserId.
          let reactionGroups: Array<{
            emoji: string;
            count: number;
            users: unknown[];
          }> = [];
          try {
            const grouped = await reactionService.getMessageReactions({
              messageId: req.messageId,
              roomId: req.conversationId,
              requesterId: req.userId,
            });
            reactionGroups = Object.entries(grouped.reactions).map(
              ([emoji, d]) => ({
                emoji,
                count: d.count,
                users: d.users,
              })
            );
          } catch (groupErr) {
            // Non-fatal: fall back to a thin grouping derived from stored ids so
            // the broadcast still carries something renderable.
            logger.warn(
              `sendReaction grouping failed, using thin fallback: ${String(groupErr)}`
            );
            const byEmoji = new Map<string, Set<string>>();
            for (const r of reactions) {
              if (!byEmoji.has(r.emoji)) byEmoji.set(r.emoji, new Set());
              byEmoji.get(r.emoji)!.add(r.userId);
            }
            reactionGroups = [...byEmoji.entries()].map(([emoji, ids]) => ({
              emoji,
              count: ids.size,
              users: [...ids].map((userId) => ({ userId })),
            }));
          }

          await redis.publish(
            `conv:${req.conversationId}`,
            JSON.stringify({
              event: "message:reaction",
              data: {
                messageId: req.messageId,
                conversationId: req.conversationId,
                reactions: reactionGroups,
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

          let message: {
            id: string;
            messageType: string;
            createdAt: Date;
            sequenceNumber: number;
          };

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

          {
            const serverTs =
              message.createdAt instanceof Date
                ? message.createdAt.getTime()
                : Date.now();
            const full = message as Record<string, unknown>;
            await redis.publish(
              `conv:${req.targetConversationId ?? ""}`,
              JSON.stringify({
                event: "message:new",
                data: buildChatMessageEvent({
                  id: message.id,
                  clientMessageId: req.clientMessageId,
                  roomId: req.targetConversationId ?? "",
                  conversationType:
                    conversationType === "GROUP" ? "GROUP" : "PRIVATE",
                  senderId: req.senderId ?? "",
                  senderName: req.senderName,
                  senderAvatar: req.senderAvatar,
                  senderRole: (full.senderRole as string) ?? "",
                  receiverId: req.receiverId,
                  messageType: message.messageType,
                  content: full.content ?? null,
                  parentMessageId: (full.parentMessageId as string) || "",
                  quoteData: full.quoteData ?? null,
                  reactions: [],
                  isForwarded: true,
                  serverTs,
                  sequenceNumber: message.sequenceNumber,
                }),
              })
            );
          }

          // Bump-to-top: fan out conv:updated to every participant's inbox.
          // Fire-and-forget — must never delay the send callback.
          {
            const targetId = req.targetConversationId ?? "";
            const bumpBase = {
              redis,
              type: (conversationType?.toUpperCase() === "GROUP"
                ? "GROUP"
                : "PRIVATE") as "GROUP" | "PRIVATE",
              roomId: targetId,
              senderId: req.senderId ?? "",
              lastMessageId: message.id,
              lastMessageAt: message.createdAt.getTime(),
              preview: { contentType: message.messageType, text: "" },
            };
            if (conversationType === "GROUP") {
              publishConvUpdatedSafe({
                ...bumpBase,
                fetchRecipients: () =>
                  deps.groupMessageService.getActiveMemberIds(targetId),
              });
            } else {
              publishConvUpdatedSafe({
                ...bumpBase,
                recipientIds: [req.senderId ?? "", req.receiverId ?? ""],
              });
            }
          }

          callback(null, {
            messageId: message.id,
            conversationId: req.targetConversationId ?? "",
            sentAt: message.createdAt.getTime(),
            sequenceNumber: message.sequenceNumber,
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

    catchupRoom: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as {
            conversationId: string;
            requesterId: string;
            sinceSeq: string | number;
            limit: number;
            conversationType: string;
          };

          const conversationType = String(
            req.conversationType ?? ""
          ).toUpperCase();
          // proto-loader delivers int64 since_seq as a STRING (longs: String).
          const sinceSeq = Number(req.sinceSeq ?? 0);
          const limit = Math.min(Math.max(req.limit || 100, 1), 200);

          const result =
            conversationType === "GROUP"
              ? await deps.groupMessageService.catchup({
                  roomId: req.conversationId,
                  userId: req.requesterId,
                  sinceSeq,
                  limit,
                })
              : await deps.privateMessageService.catchup({
                  roomId: req.conversationId,
                  userId: req.requesterId,
                  sinceSeq,
                  limit,
                });

          const events = result.events.map((e) => {
            const content = (e as { content?: unknown }).content;
            const deletedType = (e as { deletedType?: string | null })
              .deletedType;
            const editedAt = (e as { editedAt?: Date | null }).editedAt;
            const systemEvent = (e as { systemEvent?: string | null })
              .systemEvent;
            const systemData = (e as { systemData?: unknown }).systemData;
            return {
              messageId: e.id,
              conversationId: req.conversationId,
              senderId: e.senderId ?? "",
              contentType: normalizeMessageType(e.messageType),
              contentText: (content as { text?: string })?.text ?? "",
              contentJson: stringifyContent(content),
              sentAt: e.createdAt instanceof Date ? e.createdAt.getTime() : 0,
              sequenceNumber: e.sequenceNumber,
              isDeleted: e.isDeleted,
              deletedType: deletedType ?? "",
              editedAt: editedAt instanceof Date ? editedAt.getTime() : 0,
              systemEvent: systemEvent ?? "",
              systemData: systemData ? JSON.stringify(systemData) : "",
            };
          });

          callback(null, {
            conversationId: req.conversationId,
            events,
            hasMore: result.hasMore,
            lastSeq: result.lastSeq,
            authorized: result.authorized,
          });
        } catch (err) {
          logger.error(`gRPC catchupRoom error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },

    // Admin dashboard: count of active group rooms.
    getGroupCount: (
      _call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const total = await deps.groupRoomRepo.countActive();
          callback(null, { total });
        } catch (err) {
          logger.error(`gRPC getGroupCount error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },

    // Admin Group Management: filterable/sortable/paginated active group list.
    adminListGroups: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as {
            q?: string;
            fromDate?: string;
            toDate?: string;
            sortField?: string;
            sortDir?: string;
            page?: number;
            limit?: number;
          };

          const limit = Math.min(Math.max(req.limit || 20, 1), 100);
          const skip = (Math.max(req.page || 1, 1) - 1) * limit;
          const sortField =
            req.sortField === "memberCount" ? "memberCount" : "createdAt";
          const sortDir = req.sortDir === "asc" ? "asc" : "desc";
          const fromDate = parseAdminDate(req.fromDate);
          const toDate = parseAdminDate(req.toDate);

          const result = await deps.adminGroupService.listGroups({
            q: req.q || undefined,
            fromDate,
            toDate,
            sortField,
            sortDir,
            skip,
            take: limit,
          });

          callback(null, {
            groups: result.groups,
            total: result.total,
          });
        } catch (err) {
          logger.error(`gRPC adminListGroups error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },

    // Admin Group Management: single active group detail.
    adminGetGroup: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as { groupId?: string };
          const result = await deps.adminGroupService.getGroup(
            req.groupId ?? ""
          );
          callback(null, {
            found: result.found,
            ...(result.group ? { group: result.group } : {}),
          });
        } catch (err) {
          logger.error(`gRPC adminGetGroup error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },

    // Admin Group Management: filterable/paginated active member list.
    adminListGroupMembers: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as {
            groupId?: string;
            q?: string;
            role?: string;
            page?: number;
            limit?: number;
          };

          const limit = Math.min(Math.max(req.limit || 20, 1), 100);
          const skip = (Math.max(req.page || 1, 1) - 1) * limit;

          const result = await deps.adminGroupService.listGroupMembers({
            groupId: req.groupId ?? "",
            q: req.q || undefined,
            role: req.role || undefined,
            skip,
            take: limit,
          });

          callback(null, {
            found: result.found,
            members: result.members,
            total: result.total,
          });
        } catch (err) {
          logger.error(`gRPC adminListGroupMembers error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },
  };

  const communityImpl: grpc.UntypedServiceImplementation = {
    sendCommunityMessage: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as {
            communityId: string;
            roomId: string;
            senderId: string;
            clientMessageId: string;
            message: string;
            contentType: string;
            mediaKey: string;
          };

          const snaps = await deps.userSnapshotService.getUserSnapshotsMap(
            [req.senderId],
            deps.cacheRepo
          );
          const snap = snaps.get(req.senderId);
          const senderName = (snap?.displayName as string) || "";
          const senderAvatar = (snap?.avatar as string) || "";

          const attachments = req.mediaKey
            ? [{ objectKey: req.mediaKey }]
            : undefined;

          const saved = await deps.communityMessageService.sendMessage({
            roomId: req.roomId,
            sentBy: req.senderId,
            senderName,
            senderAvatar,
            message: req.message || "",
            messageType: req.contentType || "text",
            clientMessageId: req.clientMessageId || null,
            attachments,
          });

          const sentAt =
            saved.createdAt instanceof Date
              ? saved.createdAt.getTime()
              : Date.now();

          await redis.publish(
            "community:" + req.communityId,
            JSON.stringify({
              event: "community:message:new",
              data: {
                // V2 canonical fields
                id: saved.id,
                messageId: saved.id,
                communityId: req.communityId,
                roomId: saved.roomId,
                senderId: saved.sentBy,
                senderName,
                senderAvatar,
                // §1: unified UPPER-CASE casing on BOTH messageType and the
                // contentType alias (no within-event lower/upper split).
                messageType: normalizeMessageType(saved.messageType),
                content: {
                  text: saved.message ?? "",
                  files: attachments ?? [],
                },
                reactions: [],
                message: saved.message ?? "",
                contentType: normalizeMessageType(saved.messageType),
                mediaKey: req.mediaKey ?? "",
                clientMessageId: req.clientMessageId ?? "",
                serverTs: sentAt,
                sentAt,
              },
            })
          );

          // Denormalize activity to community-service so GET /communities/mine
          // can order by latest message. Uses req.communityId (the
          // community-service Community.id), NOT roomId (chat GeneralRoom.id).
          if (req.communityId) {
            publishCommunityActivitySafe({
              communityId: req.communityId,
              lastMessageAt:
                saved.createdAt instanceof Date
                  ? saved.createdAt.toISOString()
                  : new Date(sentAt).toISOString(),
              lastMessageId: saved.id,
            });
          }

          // Bump-to-top: fan out community:updated to every member's list.
          // Fire-and-forget — must never delay the send callback.
          publishCommunityUpdatedSafe({
            redis,
            communityId: req.communityId,
            // Genuine chat room id — same value as community:message:new emits.
            roomId: saved.roomId,
            fetchMembers: () =>
              deps.communityMessageService.getActiveMemberIds(req.roomId),
            senderId: req.senderId,
            lastMessageId: saved.id,
            lastMessageAt: sentAt,
            preview: {
              contentType: saved.messageType,
              text: saved.message ?? "",
            },
          });

          callback(null, {
            messageId: saved.id,
            roomId: saved.roomId,
            sentAt,
          });
        } catch (err) {
          logger.error(`gRPC sendCommunityMessage error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },

    getCommunityMessages: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as {
            roomId: string;
            requesterId: string;
            cursor: string;
            limit: number;
          };

          const limit = req.limit || 30;
          const messages = await deps.communityMessageService.getMessages({
            roomId: req.roomId,
            userId: req.requesterId,
            cursor: req.cursor || undefined,
            limit,
          });

          const last = messages[messages.length - 1];
          const nextCursor =
            last && last.createdAt instanceof Date
              ? last.createdAt.toISOString()
              : "";
          const hasMore = messages.length >= limit;

          callback(null, {
            messages: messages.map((m) => ({
              messageId: m.id,
              roomId: m.roomId,
              senderId: m.sentBy,
              message: m.message ?? "",
              contentType: normalizeMessageType(m.messageType),
              mediaKey: (() => {
                const att = Array.isArray(m.attachments)
                  ? (m.attachments[0] as Record<string, unknown> | undefined)
                  : undefined;
                return (att?.objectKey as string) ?? "";
              })(),
              sentAt:
                m.createdAt instanceof Date
                  ? m.createdAt.getTime()
                  : Date.now(),
            })),
            nextCursor,
            hasMore,
          });
        } catch (err) {
          logger.error(`gRPC getCommunityMessages error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },

    getCommunityChatSummaries: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as {
            userId: string;
            communityIds: string[];
          };

          const summaries = await deps.communityMessageService.getChatSummaries(
            {
              userId: req.userId,
              communityIds: Array.isArray(req.communityIds)
                ? req.communityIds
                : [],
            }
          );

          callback(null, {
            summaries: summaries.map((s) => ({
              communityId: s.communityId,
              unreadMessageCount: s.unreadMessageCount,
              hasLastMessage: s.hasLastMessage,
              lastMessage: s.lastMessage
                ? {
                    username: s.lastMessage.username,
                    message: s.lastMessage.message,
                    dateTime: s.lastMessage.dateTime,
                  }
                : undefined,
            })),
          });
        } catch (err) {
          logger.error(`gRPC getCommunityChatSummaries error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },

    bulkMarkCommunityRead: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as {
            userId: string;
            communityIds: string[];
          };
          const updatedCount = await deps.communityMessageService.bulkMarkRead(
            req.userId,
            Array.isArray(req.communityIds) ? req.communityIds : []
          );
          callback(null, { updatedCount });
        } catch (err) {
          logger.error(`gRPC bulkMarkCommunityRead error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },
  };

  const notificationImpl: grpc.UntypedServiceImplementation = {
    createNotification: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as {
            userId?: string;
            actorId?: string;
            type?: string;
            title?: string;
            body?: string;
            data?: Record<string, string>;
          };

          if (!req.userId || !req.type) {
            callback({
              code: grpc.status.INVALID_ARGUMENT,
              message: "userId and type are required",
            });
            return;
          }

          const data = req.data ?? {};
          // referenceId/entityId carried in data (if present) populate `entity`
          // so existing inbox queries that filter on entity.id keep working.
          const entityId = data.entityId ?? data.referenceId ?? "";

          const created = await deps.notificationRepo.create({
            userId: req.userId,
            actorId: req.actorId ?? "",
            type: req.type,
            entity: entityId ? { id: entityId } : {},
            actorSnapshot: {},
            payload: {
              title: req.title ?? "",
              body: req.body ?? "",
              data,
            },
          });

          callback(null, { id: created.id });
        } catch (err) {
          logger.error(`gRPC createNotification error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },
  };

  const server = new grpc.Server();
  server.addService(MessagingService.service, messagingImpl);
  server.addService(CommunityService.service, communityImpl);
  server.addService(NotificationGrpcService.service, notificationImpl);

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
