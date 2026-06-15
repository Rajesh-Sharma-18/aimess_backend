/**
 * chat-service gRPC service implementations (messaging / community /
 * notification). Extracted from `server.ts` so the request handlers — and the
 * resolve-on-read media wiring inside them — are unit-testable under the CJS
 * Jest harness. This module intentionally contains NO `import.meta`: proto-path
 * derivation and `protoLoader.loadSync` stay in `server.ts` (the ESM transport
 * shell), so a test can import it without tripping ts-jest's CommonJS
 * `import.meta` / `__dirname` rewrite. `startGrpcServer` wires these factories
 * onto a real grpc.Server; tests call the factories directly with mocked deps.
 */

import { randomUUID } from "node:crypto";
import * as grpc from "@grpc/grpc-js";
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
  buildMessagePreview,
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
  buildCanonicalQuote,
  groupStoredReactions,
  flattenStoredReactions,
  normalizeMessageType,
} from "../lib/chat-message.serializer.js";
import {
  resolveMediaUrl,
  resolveMediaUrlMap,
  urlFromMap,
  resolveContentFiles,
  type MediaFileLike,
} from "../lib/media-resolve.js";
import { isIdempotentReplay } from "../lib/idempotency.js";

/**
 * Resolve attachment object-keys inside a message `content` blob to full,
 * presigned download URLs for a realtime broadcast. Resolve-on-read at the
 * publish boundary — the stored content keeps the raw object keys (presigned
 * URLs expire, so a resolved URL must never be persisted).
 */
async function resolveBroadcastContent(content: unknown): Promise<unknown> {
  if (!content || typeof content !== "object") return content;
  const c = content as Record<string, unknown>;
  if (Array.isArray(c.files) && c.files.length > 0) {
    return {
      ...c,
      files: await resolveContentFiles(c.files as MediaFileLike[]),
    };
  }
  return content;
}

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

export function createMessagingImpl(
  deps: GrpcDeps
): grpc.UntypedServiceImplementation {
  return {
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
          // Track whether the service returned a pre-existing row (idempotent
          // replay) vs a fresh insert; set from the service's replay marker
          // after the call and used to suppress duplicate fan-out.
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
              clientMessageId: req.clientMessageId || randomUUID(),
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
              clientMessageId: req.clientMessageId || randomUUID(),
              clientTs,
            });
          }

          // An idempotent replay (a concurrent same-clientMessageId duplicate
          // that collapsed to the existing row, or a later retry) must NOT re-run
          // the live fan-out — the row's FIRST send already broadcast/bumped/
          // pushed. This is what makes N concurrent dup sends yield exactly ONE
          // message:new (the winning insert), while every caller still gets the
          // same messageId ack below.
          alreadySent = isIdempotentReplay(msg);

          if (!alreadySent) {
            const serverTs =
              msg.createdAt instanceof Date
                ? msg.createdAt.getTime()
                : Date.now();
            const full = msg as Record<string, unknown>;
            // Resolve-on-read: raw avatar/attachment object-keys → full presigned
            // URLs for the live push (the stored snapshot keeps the raw keys).
            const [bcastAvatar, bcastContent] = await Promise.all([
              resolveMediaUrl(req.senderAvatar || ""),
              resolveBroadcastContent(msg.content ?? null),
            ]);
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
                  senderAvatar: bcastAvatar,
                  senderRole: msg.senderRole,
                  receiverId: req.receiverId,
                  messageType: msg.messageType,
                  content: bcastContent ?? null,
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
          if (!alreadySent) {
            const bumpSentAt =
              msg.createdAt instanceof Date
                ? msg.createdAt.getTime()
                : Date.now();
            const bumpBase = {
              redis,
              type: (conversationType?.toUpperCase() === "GROUP"
                ? "GROUP"
                : "PRIVATE") as "GROUP" | "PRIVATE",
              roomId: req.conversationId,
              senderId: req.senderId,
              lastMessageId: msg.id,
              lastMessageAt: bumpSentAt,
              preview: {
                contentType: normalizeMessageType(msg.messageType),
                text: buildMessagePreview(msg.messageType, msg.content),
              },
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
          const editedContent = await resolveBroadcastContent(
            updated.content ?? null
          );
          // Resolve-on-read: an edited message may already carry reactions whose
          // avatars are stored as raw object keys. Sign them for the live push the
          // same way sendReaction does (best-effort; degrades to "" on failure) so
          // the broadcast never leaks a raw key.
          const editedReactionGroups = groupStoredReactions(
            updatedFull.reactions
          );
          const editReactAvatarMap = await resolveMediaUrlMap(
            editedReactionGroups.flatMap((g) => g.users.map((u) => u.avatar))
          );
          const resolvedEditedReactions = editedReactionGroups.map((g) => ({
            ...g,
            users: g.users.map((u) => ({
              ...u,
              avatar: urlFromMap(editReactAvatarMap, u.avatar),
            })),
          }));
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
                content: editedContent ?? null,
                parentMessageId: (updatedFull.parentMessageId as string) || "",
                quoteData: updatedFull.quoteData ?? null,
                reactions: resolvedEditedReactions,
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
            // Resolve-on-read at the gRPC wire boundary: stamp attachment URLs
            // into each message's content (mirrors the controller's enrichForWire
            // while preserving this RPC's own wire shape).
            const resolved = await Promise.all(
              messages.map(async (m) => ({
                ...m,
                content: await resolveBroadcastContent(m.content),
              }))
            );

            callback(null, {
              messages: resolved.map((m) => ({
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
              contentType: normalizeMessageType(
                (m as Record<string, unknown>).contentType as string
              ),
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

          // §2.4 toggle: react() reads-modifies-writes the stored reactor map —
          // adds the reactor on first react, removes it on a duplicate react
          // (toggle-off) — and persists the canonical reactor-object shape. The
          // getMessageReactions call below flattens it to the wire shape.
          const msg = await reactionService.react(
            req.messageId,
            req.userId,
            req.emoji
          );

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

          // Resolve-on-read: reactor avatars in the live reaction bar.
          const reactAvatarMap = await resolveMediaUrlMap(
            reactionGroups.flatMap((g) =>
              (g.users as Array<Record<string, unknown>>).map((u) =>
                typeof u.avatar === "string" ? u.avatar : ""
              )
            )
          );
          const resolvedReactionGroups = reactionGroups.map((g) => ({
            ...g,
            users: (g.users as Array<Record<string, unknown>>).map((u) =>
              typeof u.avatar === "string"
                ? { ...u, avatar: urlFromMap(reactAvatarMap, u.avatar) }
                : u
            ),
          }));
          await redis.publish(
            `conv:${req.conversationId}`,
            JSON.stringify({
              event: "message:reaction",
              data: {
                messageId: req.messageId,
                conversationId: req.conversationId,
                reactions: resolvedReactionGroups,
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
            const [fwdAvatar, fwdContent] = await Promise.all([
              resolveMediaUrl(req.senderAvatar || ""),
              resolveBroadcastContent(full.content ?? null),
            ]);
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
                  senderAvatar: fwdAvatar,
                  senderRole: (full.senderRole as string) ?? "",
                  receiverId: req.receiverId,
                  messageType: message.messageType,
                  content: fwdContent ?? null,
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
              preview: {
                contentType: normalizeMessageType(message.messageType),
                text: buildMessagePreview(
                  message.messageType,
                  (message as unknown as Record<string, unknown>).content
                ),
              },
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
}

export function createCommunityImpl(
  deps: GrpcDeps
): grpc.UntypedServiceImplementation {
  return {
    // Synchronous, idempotent room provisioning called by community-service at
    // community-creation time so a member's first send can't race the async
    // community.created event. Delegates to the same upsert as the event path.
    ensureCommunityRoom: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as {
            communityId: string;
            name: string;
            ownerId: string;
            avatarUrl: string;
          };
          if (!req.communityId) {
            callback({
              code: grpc.status.INVALID_ARGUMENT,
              message: "communityId is required",
            });
            return;
          }
          await deps.communityMessageService.provisionRoom({
            communityId: req.communityId,
            name: req.name || "",
            owner: req.ownerId || null,
            logo: req.avatarUrl || null,
          });
          callback(null, { ok: true, communityId: req.communityId });
        } catch (err) {
          logger.error(`gRPC ensureCommunityRoom error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },

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
            parentMessageId: string;
            attachmentsJson: string;
          };

          // Parse the rich attachment payload sent by new clients.
          type AttachmentsPayload = {
            files?: Array<Record<string, unknown>>;
            location?: Record<string, unknown>;
            contact?: Record<string, unknown>;
            sticker?: Record<string, unknown>;
          };
          let parsed: AttachmentsPayload = {};
          if (req.attachmentsJson) {
            try {
              parsed = JSON.parse(req.attachmentsJson) as AttachmentsPayload;
            } catch {
              // malformed JSON — treat as no attachments
            }
          }

          // Build the attachments array for the service.
          // Priority: new structured files > legacy mediaKey single key.
          let attachments: Array<Record<string, unknown>> | undefined;
          if (parsed.files?.length) {
            attachments = parsed.files;
          } else if (parsed.location) {
            attachments = [{ type: "location", ...parsed.location }];
          } else if (parsed.contact) {
            attachments = [{ type: "contact", ...parsed.contact }];
          } else if (parsed.sticker) {
            attachments = [{ type: "sticker", ...parsed.sticker }];
          } else if (req.mediaKey) {
            // backward-compat with old clients that send mediaKey only
            attachments = [{ objectKey: req.mediaKey }];
          }

          const snaps = await deps.userSnapshotService.getUserSnapshotsMap(
            [req.senderId],
            deps.cacheRepo
          );
          const snap = snaps.get(req.senderId);
          const senderName = (snap?.displayName as string) || "";
          const senderAvatar = (snap?.avatar as string) || "";

          const saved = await deps.communityMessageService.sendMessage({
            roomId: req.roomId,
            sentBy: req.senderId,
            senderName,
            senderAvatar,
            message: req.message || "",
            messageType: (req.contentType || "TEXT").toUpperCase(),
            parentMessageId: req.parentMessageId || null,
            clientMessageId: req.clientMessageId || randomUUID(),
            attachments,
          });

          const sentAt =
            saved.createdAt instanceof Date
              ? saved.createdAt.getTime()
              : Date.now();

          // Resolve-on-read for the live push: sender avatar + attachment keys
          // → full presigned URLs (the stored snapshot keeps the raw keys).
          const [bcastSenderAvatar, bcastFiles] = await Promise.all([
            resolveMediaUrl(senderAvatar || ""),
            resolveContentFiles((parsed.files ?? []) as MediaFileLike[]),
          ]);
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
                senderAvatar: bcastSenderAvatar,
                parentMessageId: saved.parentMessageId ?? "",
                quoteData: buildCanonicalQuote(saved.quoteData),
                content: {
                  text: saved.message ?? "",
                  files: bcastFiles,
                  ...(parsed.location ? { location: parsed.location } : {}),
                  ...(parsed.contact ? { contact: parsed.contact } : {}),
                  ...(parsed.sticker ? { sticker: parsed.sticker } : {}),
                },
                reactions: [],
                message: saved.message ?? "",
                contentType: normalizeMessageType(saved.messageType),
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
            const messageText = saved.message ?? "";
            publishCommunityActivitySafe({
              communityId: req.communityId,
              lastMessageAt:
                saved.createdAt instanceof Date
                  ? saved.createdAt.toISOString()
                  : new Date(sentAt).toISOString(),
              lastMessageId: saved.id,
              senderUserId: req.senderId,
              senderUsername: senderName,
              messagePreview:
                messageText.length > 80
                  ? messageText.slice(0, 80)
                  : messageText,
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
              contentType: normalizeMessageType(saved.messageType),
              text: buildMessagePreview(saved.messageType, {
                text: saved.message ?? "",
                files: parsed.files ?? [],
                ...(parsed.location ? { location: parsed.location } : {}),
                ...(parsed.contact ? { contact: parsed.contact } : {}),
              }),
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
              // getMessages now returns the wire shape: `contentType` is already
              // the canonical UPPER-CASE value (§1), so no re-normalize needed.
              contentType: m.contentType,
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

    communityCatchup: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as {
            roomId: string;
            requesterId: string;
            sinceId: string;
            limit: number;
            sinceTs: number; // epoch-ms; 0 or absent → use sinceId mode
          };

          const sinceTs =
            req.sinceTs && req.sinceTs > 0 ? new Date(req.sinceTs) : undefined;

          const result = await deps.communityMessageService.catchup({
            roomId: req.roomId,
            userId: req.requesterId,
            sinceId: req.sinceId || "",
            sinceTs,
            limit: req.limit || 100,
          });

          // Resolve-on-read: batch-sign all event sender avatars once.
          const catchupAvatarMap = await resolveMediaUrlMap(
            result.events.map((m) => m.senderAvatar ?? "")
          );
          callback(null, {
            roomId: req.roomId,
            events: result.events.map((m) => {
              // Derive syncEventType — same logic used by getMessagesSince.
              let syncEventType = "new";
              if (m.deletedForAll) {
                syncEventType = "deleted";
              } else if (m.editedAt instanceof Date) {
                syncEventType = "edited";
              } else if (
                sinceTs &&
                m.updatedAt instanceof Date &&
                m.updatedAt > m.createdAt
              ) {
                syncEventType = "reacted";
              }

              return {
                messageId: m.id,
                roomId: m.roomId,
                senderId: m.sentBy,
                senderName: m.senderName ?? "",
                senderAvatar: urlFromMap(
                  catchupAvatarMap,
                  m.senderAvatar ?? ""
                ),
                message: m.message ?? "",
                contentType: normalizeMessageType(m.messageType),
                sentAt: m.createdAt instanceof Date ? m.createdAt.getTime() : 0,
                isDeleted: m.deletedForAll,
                deletedType: m.deletedForAll ? "ALL" : "",
                editedAt: m.editedAt instanceof Date ? m.editedAt.getTime() : 0,
                syncEventType,
                reactions: groupStoredReactions(
                  m.reactions as Record<string, unknown> | null | undefined
                ),
              };
            }),
            hasMore: result.hasMore,
            lastId: result.lastId,
            authorized: result.authorized,
            nextTs: result.nextTs,
          });
        } catch (err) {
          logger.error(`gRPC communityCatchup error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },

    reactToCommunityMessage: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as {
            messageId: string;
            communityId: string;
            userId: string;
            emoji: string;
          };

          const result = await deps.communityMessageService.reactToMessage({
            messageId: req.messageId,
            userId: req.userId,
            communityId: req.communityId,
            emoji: req.emoji,
          });

          // Resolve-on-read: reactor avatars for both the broadcast and the ack.
          const rcAvatarMap = await resolveMediaUrlMap(
            result.reactions.flatMap((g) => g.users.map((u) => u.avatar ?? ""))
          );
          const resolvedReactions = result.reactions.map((g) => ({
            ...g,
            users: g.users.map((u) => ({
              ...u,
              avatar: urlFromMap(rcAvatarMap, u.avatar ?? ""),
            })),
          }));

          await redis.publish(
            `community:${req.communityId}`,
            JSON.stringify({
              event: "community:message:reaction",
              data: {
                messageId: result.messageId,
                communityId: result.communityId,
                reactions: resolvedReactions,
              },
            })
          );

          callback(null, {
            messageId: result.messageId,
            communityId: result.communityId,
            reactions: resolvedReactions.map((g) => ({
              emoji: g.emoji,
              count: g.count,
              users: g.users.map((u) => ({
                userId: u.userId,
                displayName: u.displayName,
                avatar: u.avatar,
              })),
            })),
          });
          publishCommunityActivitySafe({
            communityId: req.communityId,
            lastMessageAt: new Date().toISOString(),
            lastMessageId: req.messageId,
            senderUserId: req.userId,
            senderUsername: "",
            messagePreview: `reacted with ${req.emoji}`,
            type: "reaction",
          });
        } catch (err) {
          logger.error(`gRPC reactToCommunityMessage error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },

    editCommunityMessage: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as {
            messageId: string;
            communityId: string;
            userId: string;
            text: string;
          };
          const result = await deps.communityMessageService.editMessage({
            messageId: req.messageId,
            userId: req.userId,
            content: { text: req.text },
          });
          await redis.publish(
            `community:${req.communityId}`,
            JSON.stringify({
              event: "community:message:edited",
              data: {
                messageId: result.id,
                communityId: req.communityId,
                roomId: result.roomId,
                senderId: result.sentBy,
                message: result.message ?? "",
                contentType: normalizeMessageType(result.messageType),
                editedAt:
                  result.editedAt instanceof Date
                    ? result.editedAt.getTime()
                    : Date.now(),
              },
            })
          );
          callback(null, {
            messageId: result.id,
            communityId: req.communityId,
            roomId: result.roomId,
            editedAt:
              result.editedAt instanceof Date
                ? result.editedAt.getTime()
                : Date.now(),
            message: result.message ?? "",
            contentType: normalizeMessageType(result.messageType),
          });
          publishCommunityActivitySafe({
            communityId: req.communityId,
            lastMessageAt: new Date().toISOString(),
            lastMessageId: result.id,
            senderUserId: req.userId,
            senderUsername: "",
            messagePreview:
              req.text.length > 80 ? req.text.slice(0, 80) : req.text,
            type: "edited",
          });
        } catch (err) {
          logger.error(`gRPC editCommunityMessage error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },

    deleteCommunityMessage: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as {
            messageId: string;
            communityId: string;
            userId: string;
            deleteType: string;
          };
          const result =
            req.deleteType === "forEveryone"
              ? await deps.communityMessageService.deleteForAll(
                  req.messageId,
                  req.userId
                )
              : await deps.communityMessageService.deleteForMe(
                  req.messageId,
                  req.userId
                );
          await redis.publish(
            `community:${req.communityId}`,
            JSON.stringify({
              event: "community:message:deleted",
              data: {
                messageId: result?.id ?? req.messageId,
                communityId: req.communityId,
                roomId: result?.roomId ?? "",
                deleteType: req.deleteType,
                deletedBy: req.userId,
              },
            })
          );
          callback(null, {
            messageId: result?.id ?? req.messageId,
            communityId: req.communityId,
            roomId: result?.roomId ?? "",
            deleteType: req.deleteType,
          });
          publishCommunityActivitySafe({
            communityId: req.communityId,
            lastMessageAt: new Date().toISOString(),
            lastMessageId: req.messageId,
            senderUserId: req.userId,
            senderUsername: "",
            messagePreview: "Message deleted",
            type: "deleted",
          });
        } catch (err) {
          logger.error(`gRPC deleteCommunityMessage error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },

    pinCommunityMessage: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as {
            messageId: string;
            communityId: string;
            roomId: string;
            userId: string;
          };
          const result = await deps.communityMessageService.pinMessage({
            messageId: req.messageId,
            userId: req.userId,
            roomId: req.roomId,
            communityId: req.communityId,
          });
          await redis.publish(
            `community:${req.communityId}`,
            JSON.stringify({
              event: "community:message:pinned",
              data: {
                messageId: req.messageId,
                communityId: req.communityId,
                roomId: req.roomId,
                pinnedIds: result.pinnedIds,
                pinnedCount: result.pinnedCount,
                pinnedAt: result.pinnedAt,
                pinnedBy: req.userId,
              },
            })
          );
          callback(null, {
            messageId: req.messageId,
            communityId: req.communityId,
            roomId: req.roomId,
            pinnedIds: JSON.stringify(result.pinnedIds),
            pinnedCount: result.pinnedCount,
            pinnedAt: result.pinnedAt,
          });
          publishCommunityActivitySafe({
            communityId: req.communityId,
            lastMessageAt: new Date().toISOString(),
            lastMessageId: req.messageId,
            senderUserId: req.userId,
            senderUsername: "",
            messagePreview: "Message pinned",
            type: "pinned",
          });
        } catch (err) {
          logger.error(`gRPC pinCommunityMessage error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },

    unpinCommunityMessage: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as {
            messageId: string;
            communityId: string;
            roomId: string;
            userId: string;
          };
          const result = await deps.communityMessageService.unpinMessage({
            messageId: req.messageId,
            userId: req.userId,
            roomId: req.roomId,
            communityId: req.communityId,
          });
          await redis.publish(
            `community:${req.communityId}`,
            JSON.stringify({
              event: "community:message:unpinned",
              data: {
                messageId: req.messageId,
                communityId: req.communityId,
                roomId: req.roomId,
                pinnedIds: result.pinnedIds,
                pinnedCount: result.pinnedCount,
                unpinnedBy: req.userId,
              },
            })
          );
          callback(null, {
            messageId: req.messageId,
            communityId: req.communityId,
            roomId: req.roomId,
            pinnedIds: JSON.stringify(result.pinnedIds),
            pinnedCount: result.pinnedCount,
          });
          publishCommunityActivitySafe({
            communityId: req.communityId,
            lastMessageAt: new Date().toISOString(),
            lastMessageId: req.messageId,
            senderUserId: req.userId,
            senderUsername: "",
            messagePreview: "Message unpinned",
            type: "unpinned",
          });
        } catch (err) {
          logger.error(`gRPC unpinCommunityMessage error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },
  };
}

export function createNotificationImpl(
  deps: GrpcDeps
): grpc.UntypedServiceImplementation {
  return {
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
}
