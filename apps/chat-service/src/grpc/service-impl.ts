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
import { isAppError, ForbiddenError } from "@aimess/errors";
import { publishUserSocketEvent } from "@aimess/redis";
import { buildReactionActivityText } from "@aimess/constants";
import { redis } from "../config/redis.js";
import { publishCommunityActivitySafe } from "../events/publish-community-activity.js";
import {
  reconcileCommunityLastActivityAfterDelete,
  bumpTimestampAfterDelete,
} from "../events/community-last-activity.js";
import {
  publishConvUpdatedSafe,
  publishCommunityUpdatedSafe,
} from "../events/publish-conv-updated.js";
import { publishMessageSentSafe } from "../events/publish-message-sent.js";
import { renderCommunityOverrides } from "../lib/recipient-override-render.js";
import { getCommunityReconcileClient } from "./community.client.js";
import { publishCommunityEffectiveLastLoss } from "../events/publish-effective-last-loss.js";
import {
  convertMessageToPreview,
  buildPushPreview,
} from "../services/message-preview.service.js";
import type { PrivateRoomService } from "../services/private-room.service.js";
import type { PrivateMessageService } from "../services/private-message.service.js";
import type { GroupMessageService } from "../services/group-message.service.js";
import type { GroupMemberService } from "../services/group-member.service.js";
import type { GroupRoomRepository } from "../repositories/group-room.repository.js";
import type { GroupMemberRepository } from "../repositories/group-member.repository.js";
import type { PrivateRoomRepository } from "../repositories/private-room.repository.js";
import type { RoomMemberRepository } from "../repositories/room-member.repository.js";
import type { GeneralRoomRepository } from "../repositories/general-room.repository.js";
import type { AdminGroupService } from "../services/admin-group.service.js";
import type { CacheRepository } from "../repositories/cache.repository.js";
import type { UserSnapshotService } from "../services/user-snapshot.service.js";
import type { CallService } from "../services/call.service.js";
import type { CallFlagService } from "../services/call-flag.service.js";
import type { CallAnalyticsRepository } from "../repositories/call-analytics.repository.js";
import type { PresenceService } from "../services/presence.service.js";
import type { CommunityMessageService } from "../services/community-message.service.js";
import { resolveConversationType } from "../lib/conversation-type.js";
import type { CommunityPinService } from "../services/community-pin.service.js";
import type { NotificationRepository } from "../repositories/notification.repository.js";
import type { ChatMessageOrchestrator } from "../services/chat-message-orchestrator.js";
import { resolveSenderIdentity } from "../lib/resolve-sender-identity.js";
import {
  autoDeleteWireFields,
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
  resolveQuoteThumbnail,
  fileMediaKey,
  pushImageKeyOf,
  type MediaFileLike,
} from "../lib/media-resolve.js";
import { isIdempotentReplay } from "../lib/idempotency.js";
import { getAlbumMessages } from "../lib/album-messages.js";
import { assertPrivateParticipant } from "../lib/access-guard.js";
import { unpinAfterDelete } from "../lib/pin-after-delete.js";
import { buildParticipantsKey } from "../lib/room-id.js";
import { serializeNotification } from "../lib/notification-serializer.js";
import { resolveAvatarRefresh } from "../services/notification.service.js";
import {
  resolveGroupKey,
  resolveTransition,
  isTerminalRemoval,
} from "../lib/notification-identity.js";
import { resolveNotificationFriendship } from "../lib/notification-friendship.enricher.js";

/**
 * Resolve attachment object-keys inside a message `content` blob to full,
 * presigned download URLs for a realtime broadcast. Resolve-on-read at the
 * publish boundary — the stored content keeps the raw object keys (presigned
 * URLs expire, so a resolved URL must never be persisted).
 */
async function resolveBroadcastContent(content: unknown): Promise<unknown> {
  if (!content || typeof content !== "object") return content;
  const c = content as Record<string, unknown>;
  const hasFiles = Array.isArray(c.files) && c.files.length > 0;
  // `content.sticker` lives outside files[] and needs the same resolve-on-read
  // as REST history gives it (lib/media-resolve.ts `resolveStickerField`).
  const sticker =
    c.sticker && typeof c.sticker === "object"
      ? (c.sticker as MediaFileLike)
      : null;
  if (!hasFiles && !sticker) return content;
  const [files, stickerUrl] = await Promise.all([
    hasFiles
      ? resolveContentFiles(c.files as MediaFileLike[])
      : Promise.resolve(null),
    sticker ? resolveMediaUrl(fileMediaKey(sticker)) : Promise.resolve(""),
  ]);
  return {
    ...c,
    ...(files ? { files } : {}),
    ...(sticker && stickerUrl
      ? { sticker: { ...sticker, url: stickerUrl } }
      : {}),
  };
}

/** Maps an `AppError.statusCode` (HTTP convention, from `@aimess/errors`) to the
 * closest gRPC status. Unmapped/unexpected statuses fall back to INTERNAL. */
const APP_ERROR_STATUS_TO_GRPC: Record<number, grpc.status> = {
  400: grpc.status.INVALID_ARGUMENT,
  401: grpc.status.UNAUTHENTICATED,
  403: grpc.status.PERMISSION_DENIED,
  404: grpc.status.NOT_FOUND,
  409: grpc.status.ALREADY_EXISTS,
  410: grpc.status.FAILED_PRECONDITION,
  415: grpc.status.INVALID_ARGUMENT,
  429: grpc.status.RESOURCE_EXHAUSTED,
};

/**
 * Map a caught service-layer error to a gRPC callback error object, preserving
 * an `AppError`'s `messageKey` (e.g. "CHAT_MESSAGE_NOT_FOUND") verbatim as the
 * gRPC error message so the gateway can resolve a specific, localized ack
 * message instead of a generic one (see `resolveGrpcAckError` in
 * api-gateway's `sockets/ack.ts`). `messageKey` is always a short catalog
 * token, never free text, so this can never leak internals/stack traces.
 * Any non-`AppError` (Prisma failure, unexpected bug, etc.) becomes a generic
 * INTERNAL error with a safe, non-descriptive message — exactly the previous
 * behavior for truly unexpected failures, minus the `String(err)` leak.
 */
function toGrpcCallbackError(err: unknown): {
  code: grpc.status;
  message: string;
} {
  if (isAppError(err)) {
    return {
      code: APP_ERROR_STATUS_TO_GRPC[err.statusCode] ?? grpc.status.INTERNAL,
      message: err.messageKey ?? "INTERNAL_ERROR",
    };
  }
  return { code: grpc.status.INTERNAL, message: "INTERNAL_ERROR" };
}

export interface GrpcDeps {
  privateMessageService: PrivateMessageService;
  groupMessageService: GroupMessageService;
  groupMemberService: GroupMemberService;
  groupRoomRepo: GroupRoomRepository;
  groupMemberRepo: GroupMemberRepository;
  privateRoomRepo: PrivateRoomRepository;
  roomMemberRepo: RoomMemberRepository;
  generalRoomRepo: GeneralRoomRepository;
  adminGroupService: AdminGroupService;
  cacheRepo: CacheRepository;
  userSnapshotService: UserSnapshotService;
  callService: CallService;
  /** Admin call analytics + health counters (backoffice has no DB access). */
  callAnalyticsRepo: CallAnalyticsRepository;
  /** Platform-wide calling kill-switch, read/written by the admin panel. */
  callFlagService: CallFlagService;
  presenceService: PresenceService;
  communityMessageService: CommunityMessageService;
  communityPinService: CommunityPinService;
  notificationRepo: NotificationRepository;
  chatMessageOrchestrator: ChatMessageOrchestrator;
  privateRoomService: PrivateRoomService;
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
      // STICKER media lives outside files[]; dropping it here persisted an
      // empty content blob, so the sticker vanished on the next history read.
      ...(parsed.sticker ? { sticker: parsed.sticker } : {}),
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

function publishRealtimeSafe(
  channel: string,
  event: string,
  data: unknown,
  context: string
): void {
  redis
    .publish(channel, JSON.stringify({ event, data }))
    .catch((err: unknown) => {
      logger.warn(
        `realtime publish failed event=${event} channel=${channel} ${context}: ${String(err)}`
      );
    });
}

/**
 * Fan `message:new` out on every participant's PERSONAL bus, in addition to the
 * `conv:<roomId>` room broadcast.
 *
 * WHY BOTH. A socket joins `conv:<id>` only when the client opens that chat
 * (`conversation:join`), but joins `user:<id>` on connect. So the room broadcast
 * alone reaches a recipient ONLY while they are sitting in that exact chat — not
 * when they are on the chat list, in a different chat, or backgrounded, which is
 * the normal case. Those recipients therefore never ran the client's delivery-receipt
 * path, and the sender's bubble stayed on a single tick forever.
 *
 * `conv:updated` already uses this personal-bus pattern, which is why the inbox row
 * updated while the message event itself went missing.
 *
 * Clients dedupe by `serverMessageId` (and the delivery receipt is debounced per room),
 * so a recipient who IS in the chat and receives both copies is a no-op.
 */
function publishMessageNewToParticipants(
  recipientIds: string[],
  payload: unknown,
  context: string,
  excludeUserId: string
): void {
  for (const userId of new Set(recipientIds.filter(Boolean))) {
    // Skip the sender: their socket is already in `conv:<roomId>` (from
    // sending) and gets the room broadcast above, so a personal-channel copy
    // on top of that double-delivers `message:new` to just them.
    if (userId === excludeUserId) continue;
    publishRealtimeSafe(`user:${userId}`, "message:new", payload, context);
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

          // Authoritative: derived from the room id, NOT req.conversationType.
          // A client claiming "private" for a grp_ room was being sent through
          // the friendship gate ("You must be friends to message this user").
          const conversationType = resolveConversationType(
            req.conversationId,
            req.conversationType
          );
          const content = parseMessageContent(req);
          // Server-side resolution — req.senderName/Avatar are optional,
          // client-supplied fields that arrive empty over the socket path.
          const {
            senderName: resolvedSenderName,
            senderAvatar: resolvedSenderAvatar,
          } = await resolveSenderIdentity(
            deps.userSnapshotService,
            deps.cacheRepo,
            req.senderId,
            req.senderName || undefined,
            req.senderAvatar || undefined
          );
          if (conversationType === "GROUP") {
            msg = await deps.groupMessageService.sendMessage({
              roomId: req.conversationId,
              senderId: req.senderId,
              senderName: resolvedSenderName,
              senderAvatar: resolvedSenderAvatar,
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
            const [bcastAvatar] = await Promise.all([
              resolveMediaUrl(resolvedSenderAvatar),
            ]);
            const albumRows = getAlbumMessages(msg);
            for (const row of albumRows) {
              const rowFull = row as Record<string, unknown>;
              const rowServerTs =
                row.createdAt instanceof Date
                  ? row.createdAt.getTime()
                  : serverTs;
              const bcastContent = await resolveBroadcastContent(
                row.content ?? null
              );
              const rowPayload = buildChatMessageEvent({
                id: row.id,
                clientMessageId: req.clientMessageId,
                roomId: req.conversationId,
                conversationType:
                  conversationType === "GROUP" ? "GROUP" : "PRIVATE",
                senderId: req.senderId,
                senderName: resolvedSenderName,
                senderAvatar: bcastAvatar,
                senderRole:
                  (row as { senderRole?: string }).senderRole ?? msg.senderRole,
                receiverId: req.receiverId,
                messageType: row.messageType,
                content: bcastContent ?? null,
                parentMessageId: (rowFull.parentMessageId as string) || "",
                quoteData: rowFull.quoteData ?? null,
                reactions: [],
                clientTs,
                serverTs: rowServerTs,
                sequenceNumber: row.sequenceNumber,
                countInUnread: (
                  row as unknown as { countInUnread?: boolean | null }
                ).countInUnread,
                // Without this the socket send path — the one the web/mobile
                // clients actually use — broadcasts a message with no auto-delete
                // deadline, so no countdown shows until a refetch reveals one
                // that has already expired.
                ...autoDeleteWireFields(row),
              });
              const bcastContext = `roomId=${req.conversationId} messageId=${row.id} sequenceNumber=${row.sequenceNumber}`;
              publishRealtimeSafe(
                `conv:${req.conversationId}`,
                "message:new",
                rowPayload,
                bcastContext
              );
              // Personal bus too — reaches recipients who don't have this chat open,
              // which is what makes the delivered tick work. See the helper's KDoc.
              if (conversationType === "GROUP") {
                void deps.groupMessageService
                  .getActiveMemberIds(req.conversationId)
                  .then((ids) =>
                    publishMessageNewToParticipants(
                      ids,
                      rowPayload,
                      bcastContext,
                      req.senderId
                    )
                  )
                  .catch((err: unknown) => {
                    logger.warn(
                      `message:new personal fan-out failed ${bcastContext}: ${String(err)}`
                    );
                  });
              } else {
                publishMessageNewToParticipants(
                  [req.senderId, req.receiverId],
                  rowPayload,
                  bcastContext,
                  req.senderId
                );
              }
            }
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
              // The SERVER-resolved name, not `req.senderName` — the socket
              // path leaves that empty, and a group list row renders
              // "<senderName>: <preview>".
              senderName: resolvedSenderName,
              lastMessageId: msg.id,
              lastMessageAt: bumpSentAt,
              preview: {
                contentType: normalizeMessageType(msg.messageType),
                text: convertMessageToPreview(msg.messageType, msg.content),
                // `seq` is the client's tie-breaker when a rapid burst puts two
                // bumps in the same millisecond (see lib/list-row-identity.ts).
                // Omitting it here left the primary socket send path publishing
                // seq 0, so the client had nothing to order those bumps by.
                seq: msg.sequenceNumber ?? 0,
                createdAt: bumpSentAt,
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
              senderName: resolvedSenderName,
              senderAvatar: resolvedSenderAvatar,
              preview: buildPushPreview(msg.messageType, pushText),
              ...(pushImageKeyOf(msg.messageType, msg.content)
                ? {
                    previewImageKey: pushImageKeyOf(
                      msg.messageType,
                      msg.content
                    ),
                  }
                : {}),
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
          callback(toGrpcCallbackError(err));
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

          // Authoritative: derived from the room id, NOT req.conversationType —
          // same rationale as sendMessage above (see resolveConversationType).
          const conversationType = resolveConversationType(
            req.conversationId,
            req.conversationType
          );

          const content = parseMessageContent(req);
          const updated =
            conversationType === "GROUP"
              ? await deps.groupMessageService.editMessage({
                  messageId: req.messageId,
                  userId: req.editorId,
                  content,
                })
              : await deps.privateMessageService.editMessage({
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
            editedReactionGroups.flatMap((g) => g.users.map((u) => u.avatarUrl))
          );
          const resolvedEditedReactions = editedReactionGroups.map((g) => ({
            ...g,
            users: g.users.map((u) => ({
              ...u,
              avatarUrl: urlFromMap(editReactAvatarMap, u.avatarUrl),
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
                conversationType,
                senderId: updated.senderId ?? "",
                // GROUP denormalizes senderName/senderAvatar on the row (same
                // fields the REST edit controller reads); PRIVATE has no
                // equivalent and keeps its receiverId instead.
                ...(conversationType === "GROUP"
                  ? {
                      senderName: (updatedFull.senderName as string) ?? "",
                      senderAvatar: (updatedFull.senderAvatar as string) ?? "",
                    }
                  : { receiverId: (updatedFull.receiverId as string) ?? "" }),
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
                // An edit re-emits the whole message; without the deadline the
                // client drops the countdown it was already rendering.
                ...autoDeleteWireFields(updated),
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
                // Canonical grouped reactions on the row (thin `reactions` kept
                // for back-compat); FE reads `reactionGroups[]`. See messaging.proto.
                reactionGroups: groupStoredReactions(
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
              // Canonical grouped reactions on the row (thin `reactions` kept
              // for back-compat); FE reads `reactionGroups[]`. See messaging.proto.
              reactionGroups: groupStoredReactions(
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

          // ONE read path. This handler used to be a hand-copied second
          // implementation of `markReadDirect`, and the two had already drifted
          // (only the REST copy dismissed the reader's tray notification), so
          // every fix had to be made twice or silently landed in one transport
          // only. The socket `message:read` event arrives HERE, so the copy was
          // the one most users actually hit. `markReadDirect` does the
          // membership check, the forward-only pointer advance, the
          // `message:read` receipt, the `read_sync` device fan-out, the
          // nav-badge poke and the tray dismiss.
          const { readToSeq } =
            await deps.chatMessageOrchestrator.markReadDirect({
              conversationType: resolveConversationType(
                req.conversationId,
                req.conversationType
              ),
              roomId: req.conversationId,
              readerId: req.readerId,
              upToMessageId: req.upToMessageId,
            });
          // 0 = rejected (not a member, foreign or malformed target) or nothing
          // left to advance — either way no row was updated.
          callback(null, { updatedCount: readToSeq > 0 ? 1 : 0 });
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

          // The ROOM decides, never the caller's claim — same rule as
          // markMessagesRead (a `grp_` id sent with conversationType "private"
          // used to fall through to the PRIVATE branch and silently no-op).
          const conversationType = resolveConversationType(
            req.conversationId,
            req.conversationType
          );
          const isGroup = conversationType === "GROUP";

          const { count, messageIds } = isGroup
            ? await deps.groupMessageService.markDelivered({
                roomId: req.conversationId,
                recipientId: req.recipientId,
                upToMessageId: req.upToMessageId,
              })
            : await deps.privateMessageService.markDelivered({
                roomId: req.conversationId,
                recipientId: req.recipientId,
                upToMessageId: req.upToMessageId,
              });

          if (count > 0) {
            const deliveredPayload = JSON.stringify({
              event: "message:delivered",
              data: {
                conversationId: req.conversationId,
                recipientId: req.recipientId,
                upToMessageId: req.upToMessageId,
                messageIds,
              },
            });
            await redis.publish(`conv:${req.conversationId}`, deliveredPayload);

            // ALSO publish directly to each sender's own `user:<id>` channel — see
            // the identical comment on markMessagesRead. Private has exactly one
            // other participant; a group fans out to the whole active roster.
            const senderIds = isGroup
              ? await deps.groupMessageService
                  .getActiveMemberIds(req.conversationId)
                  .then((ids) => ids.filter((id) => id !== req.recipientId))
                  .catch(() => [] as string[])
              : await deps.privateMessageService
                  .getPeerId(req.conversationId, req.recipientId)
                  .then((id) => (id ? [id] : []))
                  .catch(() => [] as string[]);
            for (const senderId of senderIds) {
              void redis
                .publish(`user:${senderId}`, deliveredPayload)
                .catch((e: unknown) =>
                  logger.warn(
                    `message:delivered direct publish failed userId=${senderId}: ${String(e)}`
                  )
                );
            }
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
            mode?: string;
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

          // Authorize the caller against the room BEFORE binding/mutating the
          // message: unlike the socket comment previously assumed, message:react
          // is NOT gated by a prior room-join on the socket, so this gRPC
          // boundary is the only enforcement point. Without this, any
          // authenticated user who learns a messageId+conversationId for a
          // room they aren't in could react to (and broadcast into) it.
          //
          // Bind message↔room BEFORE the react: react() mutates/broadcasts by
          // messageId ALONE, so a caller authorized for room A could otherwise
          // react to (and re-broadcast) a message from room B. assertMessageInRoom
          // throws NotFound on mismatch (the catch below maps it to gRPC INTERNAL).
          if (reactConversationType === "GROUP") {
            // Write boundary — also rejects a moderation-muted member
            // (CHAT_MUTED_IN_GROUP), same as the community react path.
            await deps.groupMessageService.assertCanWrite(
              req.conversationId,
              req.userId
            );
            await deps.groupMessageService.assertMessageInRoom(
              req.conversationId,
              req.messageId
            );
          } else {
            await deps.privateMessageService.assertParticipant(
              req.conversationId,
              req.userId
            );
            await deps.privateMessageService.assertMessageInRoom(
              req.conversationId,
              req.messageId
            );
          }

          // §2.4 CAS toggle (PrivateMessageService.reactCas / GroupMessageService.
          // reactCas): adds the reactor on first react, removes it on a duplicate
          // react (toggle-off), one reaction per user — and also returns the
          // add/remove + target info needed to bump the WhatsApp-style
          // lastActivity below. The getMessageReactions call further down
          // flattens the persisted reactions to the wire shape.
          const toggled = await reactionService.reactToMessage({
            messageId: req.messageId,
            userId: req.userId,
            emoji: req.emoji,
          });

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
          let groupingFailed = false;
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
            // Non-fatal: the reaction write already succeeded (toggled above).
            // But an EMPTY group set is not "unknown", it reads as "nobody has
            // reacted" — broadcasting it wiped the reaction bar on every OTHER
            // client while the reactor kept their own optimistic chip, and the
            // two never reconverged. Skip the broadcast instead; clients pick
            // the true state up from the next getMessageReactions/changes read.
            logger.warn(
              `sendReaction grouping failed, skipping broadcast: ${String(groupErr)}`
            );
            reactionGroups = [];
            groupingFailed = true;
          }

          // Flatten stored reactions for the gRPC ack (V1 thin shape — the
          // ReactionDto proto carries {userId, emoji}; the gateway maps it).
          const reactions: Array<{ emoji: string; userId: string }> = [];
          for (const g of reactionGroups) {
            for (const u of g.users as Array<{ userId: string }>)
              reactions.push({ emoji: g.emoji, userId: u.userId });
          }

          // Resolve-on-read: reactor avatars in the live reaction bar.
          // `reactionGroups` comes from getMessageReactions whose users have an
          // `avatar` key (raw object-key). Resolve it and surface as `avatarUrl`.
          const reactAvatarMap = await resolveMediaUrlMap(
            reactionGroups.flatMap((g) =>
              (g.users as Array<Record<string, unknown>>).map(
                (u) =>
                  (typeof u.avatarUrl === "string"
                    ? u.avatarUrl
                    : (u.avatar as string)) || ""
              )
            )
          );
          const resolvedReactionGroups = reactionGroups.map((g) => ({
            ...g,
            users: (g.users as Array<Record<string, unknown>>).map((u) => {
              const rawKey =
                (typeof u.avatarUrl === "string"
                  ? u.avatarUrl
                  : (u.avatar as string)) || "";
              const { avatar: _dropped, ...rest } = u;
              return { ...rest, avatarUrl: urlFromMap(reactAvatarMap, rawKey) };
            }),
          }));
          if (!groupingFailed) {
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
          }

          // WhatsApp-style lastActivity bump/revert, AWAITED BEFORE the ack —
          // same rule the community react handlers already follow: a client that
          // re-reads its list row on this ack must never land before the overlay
          // write. The live bump inside is still fire-and-forget, and a failure
          // here only warns (the reaction itself is already persisted).
          await deps.chatMessageOrchestrator
            .bumpReactionActivity({
              conversationType:
                reactConversationType === "GROUP" ? "GROUP" : "PRIVATE",
              roomId: req.conversationId,
              messageId: req.messageId,
              emoji: req.emoji,
              actorId: req.userId,
              added: toggled.added,
              targetUserId: toggled.targetUserId,
              targetMessagePreview: toggled.targetMessagePreview,
            })
            .catch((err: unknown) =>
              logger.warn(`sendReaction activity bump failed: ${String(err)}`)
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

          // Same server-side resolution as `sendMessage` above: the socket path
          // sends these empty, and a group row denormalizes the name onto both
          // the message and the list preview.
          const { senderName: fwdSenderName, senderAvatar: fwdSenderAvatar } =
            await resolveSenderIdentity(
              deps.userSnapshotService,
              deps.cacheRepo,
              req.senderId ?? "",
              req.senderName || undefined,
              req.senderAvatar || undefined
            );

          let message: {
            id: string;
            messageType: string;
            createdAt: Date;
            sequenceNumber: number;
          };

          if (conversationType === "GROUP") {
            message = await deps.groupMessageService.forwardMessage({
              sourceMessageId: req.messageId ?? "",
              // gRPC carries only targetConversationId (no source-room field), so we
              // pass null — but the service ALWAYS binds the caller to the source
              // message's actual room, closing the cross-room read-IDOR on this path.
              sourceRoomId: null,
              targetRoomId: req.targetConversationId ?? "",
              senderId: req.senderId ?? "",
              senderName: fwdSenderName,
              senderAvatar: fwdSenderAvatar,
              clientMessageId: req.clientMessageId ?? null,
            });
          } else {
            message = await deps.privateMessageService.forwardMessage({
              sourceMessageId: req.messageId ?? "",
              // gRPC carries only targetConversationId (no source-room field), so we
              // pass null — but the service ALWAYS binds the caller to the source
              // message's actual room, closing the cross-room read-IDOR on this path.
              sourceRoomId: null,
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
              resolveMediaUrl(fwdSenderAvatar),
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
                  senderName: fwdSenderName,
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
                  countInUnread: (
                    message as unknown as { countInUnread?: boolean | null }
                  ).countInUnread,
                  // A forward is a brand-new message in the TARGET room and
                  // carries THAT room's timer.
                  ...autoDeleteWireFields(message),
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
              senderName: fwdSenderName,
              lastMessageId: message.id,
              lastMessageAt: message.createdAt.getTime(),
              preview: {
                contentType: normalizeMessageType(message.messageType),
                text: convertMessageToPreview(
                  message.messageType,
                  (message as unknown as Record<string, unknown>).content
                ),
                // See the send bump above — same same-millisecond tie-breaker.
                seq: message.sequenceNumber ?? 0,
                createdAt: message.createdAt.getTime(),
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

    // Parity with community's DeleteCommunityMessage — reuses the same
    // deleteDirect effects (tombstone broadcast + bump) the REST delete
    // controllers run, via the orchestrator, so the gateway's /chat socket
    // namespace can offer message:delete like /community's message:delete.
    deleteMessage: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as {
            conversationId: string;
            messageId: string;
            userId: string;
            deleteType?: string;
            conversationType?: string;
          };
          const conversationType =
            typeof req.conversationType === "string" &&
            req.conversationType.toUpperCase() === "GROUP"
              ? "GROUP"
              : "PRIVATE";
          const scope: "forMe" | "forEveryone" =
            req.deleteType === "forEveryone" ? "forEveryone" : "forMe";

          const { tombstone } = await deps.chatMessageOrchestrator.deleteDirect(
            {
              conversationType,
              roomId: req.conversationId,
              messageId: req.messageId,
              userId: req.userId,
              scope,
            }
          );

          callback(null, {
            messageId: (tombstone as { messageId?: string }).messageId ?? "",
            conversationId: req.conversationId,
            deleteType: scope,
          });
        } catch (err) {
          logger.error(`gRPC deleteMessage error: ${String(err)}`);
          callback(toGrpcCallbackError(err));
        }
      })();
    },

    // Parity with community's PinCommunityMessage.
    pinMessage: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as {
            conversationId: string;
            messageId: string;
            userId: string;
            conversationType?: string;
          };
          const conversationType =
            typeof req.conversationType === "string" &&
            req.conversationType.toUpperCase() === "GROUP"
              ? "GROUP"
              : "PRIVATE";

          const result = await deps.chatMessageOrchestrator.pinDirect({
            conversationType,
            roomId: req.conversationId,
            messageId: req.messageId,
            userId: req.userId,
          });

          const pin = result.pin as { pinnedAt?: unknown };
          const pinnedAt =
            pin.pinnedAt instanceof Date ? pin.pinnedAt.getTime() : Date.now();

          callback(null, {
            messageId: req.messageId,
            conversationId: req.conversationId,
            pinnedCount: result.pinnedCount,
            pinnedAt,
          });
        } catch (err) {
          logger.error(`gRPC pinMessage error: ${String(err)}`);
          callback(toGrpcCallbackError(err));
        }
      })();
    },

    // Parity with community's UnpinCommunityMessage.
    unpinMessage: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as {
            conversationId: string;
            messageId: string;
            userId: string;
            conversationType?: string;
          };
          const conversationType =
            typeof req.conversationType === "string" &&
            req.conversationType.toUpperCase() === "GROUP"
              ? "GROUP"
              : "PRIVATE";

          const result = await deps.chatMessageOrchestrator.unpinDirect({
            conversationType,
            roomId: req.conversationId,
            messageId: req.messageId,
            userId: req.userId,
          });

          callback(null, {
            messageId: req.messageId,
            conversationId: req.conversationId,
            pinnedCount: result.pinnedCount,
          });
        } catch (err) {
          logger.error(`gRPC unpinMessage error: ${String(err)}`);
          callback(toGrpcCallbackError(err));
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

          // Authorize the caller against the room before reading reactor
          // identities: without this, any authenticated user who learns a
          // messageId+conversationId for a room they aren't in could fetch
          // the full reactor list (userId/displayName/avatar) — an IDOR.
          if (conversationType === "GROUP") {
            await deps.groupMessageService.assertMember(
              req.conversationId ?? "",
              req.requesterId ?? ""
            );
          } else {
            await deps.privateMessageService.assertParticipant(
              req.conversationId ?? "",
              req.requesterId ?? ""
            );
          }

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
            groupId?: string;
          };
          const result = req.groupId
            ? await deps.callService.initiateGroupCall({
                callerId: req.callerId ?? "",
                groupId: req.groupId,
                type: req.type ?? "AUDIO",
              })
            : await deps.callService.initiateCall({
                callerId: req.callerId ?? "",
                calleeId: req.calleeId ?? "",
                type: req.type ?? "AUDIO",
                privateRoomId: req.privateRoomId ?? null,
              });

          callback(null, {
            callId: result.callId,
            status: result.status,
            livekit: {
              url: result.livekit.url,
              token: result.livekit.token,
            },
          });
        } catch (err) {
          logger.error(`gRPC initiateCall error: ${String(err)}`);
          // AppErrors must NOT be INTERNAL — opossum treats INTERNAL as infra
          // failure, replaces it with "messaging.* unavailable", and opens the
          // circuit so every subsequent call RPC fails.
          callback(toGrpcCallbackError(err));
        }
      })();
    },

    answerCall: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as {
            callId?: string;
            calleeId?: string;
            legId?: string;
            sessionId?: string;
          };
          const result = await deps.callService.answerCall({
            callId: req.callId ?? "",
            calleeId: req.calleeId ?? "",
            legId: req.legId || undefined,
            sessionId: req.sessionId || undefined,
          });
          callback(null, {
            callId: result.callId,
            status: result.status,
            livekit: {
              url: result.livekit.url,
              token: result.livekit.token,
            },
          });
        } catch (err) {
          logger.error(`gRPC answerCall error: ${String(err)}`);
          callback(toGrpcCallbackError(err));
        }
      })();
    },

    declineCall: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as {
            callId?: string;
            calleeId?: string;
            sessionId?: string;
          };
          const result = await deps.callService.declineCall({
            callId: req.callId ?? "",
            calleeId: req.calleeId ?? "",
            sessionId: req.sessionId || undefined,
          });
          callback(null, { callId: result.callId, status: result.status });
        } catch (err) {
          logger.error(`gRPC declineCall error: ${String(err)}`);
          callback(toGrpcCallbackError(err));
        }
      })();
    },

    endCall: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as {
            callId?: string;
            userId?: string;
            legId?: string;
            reason?: string;
            sessionId?: string;
          };
          const result = await deps.callService.endCall({
            callId: req.callId ?? "",
            userId: req.userId ?? "",
            legId: req.legId || undefined,
            reason: req.reason === "NO_ANSWER" ? "NO_ANSWER" : undefined,
            sessionId: req.sessionId || undefined,
          });
          callback(null, {
            callId: result.callId,
            status: result.status,
            durationSec: result.durationSec ?? 0,
          });
        } catch (err) {
          logger.error(`gRPC endCall error: ${String(err)}`);
          callback(toGrpcCallbackError(err));
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

    handleLiveKitRoomFinished: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<Record<string, never>>
    ) => {
      void (async () => {
        try {
          const req = call.request as {
            roomName?: string;
            eventType?: string;
            remainingParticipants?: number;
          };
          await deps.callService.reconcileFromLiveKitRoomFinished(
            req.roomName ?? "",
            req.eventType ?? "",
            req.remainingParticipants ?? -1
          );
          callback(null, {});
        } catch (err) {
          logger.error(`gRPC handleLiveKitRoomFinished error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },

    handleLiveKitParticipantJoined: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<Record<string, never>>
    ) => {
      void (async () => {
        try {
          const req = call.request as {
            roomName?: string;
            participantIdentity?: string;
          };
          await deps.callService.markMediaJoined(
            req.roomName ?? "",
            req.participantIdentity ?? ""
          );
          callback(null, {});
        } catch (err) {
          logger.error(
            `gRPC handleLiveKitParticipantJoined error: ${String(err)}`
          );
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },

    /**
     * Room-independent typing fan-out roster for private/group — the exact
     * mirror of community-service's GetCommunityActiveMemberIds.
     *
     * The returned list does double duty for the gateway, identically to the
     * community implementation: (1) membership validation for the sender — a
     * non-participant / non-ACTIVE member never appears, so
     * `userIds.includes(senderId)` replaces a second round trip — and (2) the
     * recipient roster for direct `user:<id>` delivery.
     *
     * Reuses the EXISTING lookups (PrivateRoom.participants,
     * GroupMessageService.getActiveMemberIds) — no new repository method.
     * Never throws: an unknown room is an empty roster, which the gateway
     * treats as "not authorized, broadcast nothing" (fail-closed).
     */
    getRoomParticipantIds: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as {
            conversationId?: string;
            conversationType?: string;
          };
          const conversationId = req.conversationId ?? "";
          if (!conversationId) {
            callback(null, { userIds: [], mutedUserIds: [] });
            return;
          }

          if (String(req.conversationType ?? "").toUpperCase() === "GROUP") {
            // Roster + the moderation-muted subset in ONE query, so the
            // gateway can drop a muted member's typing/recording indicator
            // without a second per-keystroke round trip.
            const roster =
              await deps.groupMessageService.getActiveRoster(conversationId);
            callback(null, roster);
            return;
          }

          // PRIVATE (explicit or defaulted). `conversationType` is an ADDITIVE
          // socket field, so already-shipped clients typing in a GROUP room
          // send no hint at all and land here. Falling back to the group
          // roster when the room is not a private one keeps those clients
          // working — without it, group typing would silently resolve to an
          // empty roster and stop being delivered. The fallback costs one
          // extra indexed lookup only in that legacy-group case.
          const room = await deps.privateRoomRepo.findByRoomId(conversationId);
          // A one-directional block still suppresses typing for BOTH sides of
          // the DM: the blocker's client shouldn't leak "typing…" to someone
          // it doesn't want to hear from, and the blocked party shouldn't see
          // the blocker's presence either. Empty roster == nobody delivered to.
          const blockedBy = Array.isArray(room?.blockedBy)
            ? (room.blockedBy as string[])
            : [];
          if (!room) {
            // Legacy-client group fallback — resolve the muted subset too, so
            // an old client that omits conversationType is gated identically.
            callback(
              null,
              await deps.groupMessageService.getActiveRoster(conversationId)
            );
            return;
          }
          const userIds = blockedBy.length > 0 ? [] : (room.participants ?? []);

          // PRIVATE has no moderation mute — always an empty muted list.
          callback(null, { userIds, mutedUserIds: [] });
        } catch (err) {
          // Fail-closed: an empty roster suppresses the indicator rather than
          // leaking it. Typing is presence-only, so a dropped event is
          // strictly better than an unauthorized broadcast or a socket error.
          logger.warn(`gRPC getRoomParticipantIds error: ${String(err)}`);
          callback(null, { userIds: [], mutedUserIds: [] });
        }
      })();
    },

    /**
     * Mirror of community-service's checkCommunityMute, for private 1-to-1
     * rooms. Same expiry logic as `enrichConversations`'s `isMuted` in
     * private-room.service.ts: muted with no muteUntil = indefinite,
     * muteUntil in the future = still muted, muteUntil in the past = expired.
     */
    checkPrivateMute: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as { roomId?: string; userId?: string };
          const roomId = req.roomId ?? "";
          const userId = req.userId ?? "";
          if (!roomId || !userId) {
            callback(null, { isMuted: false, mutedUntil: 0 });
            return;
          }

          const room = await deps.privateRoomRepo.findByRoomId(roomId);
          if (room) {
            const mutedBy = (room.mutedBy ?? {}) as Record<
              string,
              { muteUntil?: string | null }
            >;
            const myMute = mutedBy[userId];
            const muteUntilMs = myMute?.muteUntil
              ? new Date(myMute.muteUntil).getTime()
              : null;
            const isMuted =
              myMute != null &&
              (muteUntilMs == null || muteUntilMs > Date.now());
            callback(null, { isMuted, mutedUntil: muteUntilMs ?? 0 });
            return;
          }

          // Not a private room — fall through to GroupMember.notificationSettings, which
          // stores the same {mute, muteUntil} shape. Without this a user who muted a group
          // chat still received every push for it.
          const member = await deps.groupMemberRepo.findByRoomAndUser(
            roomId,
            userId
          );
          const settings = (member?.notificationSettings ?? {}) as {
            mute?: boolean;
            muteUntil?: string | null;
          };
          const groupMuteUntilMs = settings.muteUntil
            ? new Date(settings.muteUntil).getTime()
            : null;
          const groupMuted =
            settings.mute === true &&
            (groupMuteUntilMs == null || groupMuteUntilMs > Date.now());

          callback(null, {
            isMuted: groupMuted,
            mutedUntil: groupMuteUntilMs ?? 0,
          });
        } catch (err) {
          // Fail-open: an oracle failure must never suppress a push.
          logger.warn(`gRPC checkPrivateMute error: ${String(err)}`);
          callback(null, { isMuted: false, mutedUntil: 0 });
        }
      })();
    },

    /**
     * Mirror of checkPrivateMute, for group rooms. `notificationSettings` is
     * per-membership (GroupMember row), not per-room — same indefinite/expiry
     * logic as private: muted with no muteUntil = indefinite, muteUntil in
     * the future = still muted, muteUntil in the past = expired.
     */
    checkGroupMute: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as { roomId?: string; userId?: string };
          const roomId = req.roomId ?? "";
          const userId = req.userId ?? "";
          if (!roomId || !userId) {
            callback(null, { isMuted: false, mutedUntil: 0 });
            return;
          }

          const member = await deps.groupMemberRepo.findByRoomAndUser(
            roomId,
            userId
          );
          const settings = (member?.notificationSettings ?? {}) as {
            mute?: boolean;
            muteUntil?: string | null;
          };
          const muteUntilMs = settings.muteUntil
            ? new Date(settings.muteUntil).getTime()
            : null;
          const isMuted =
            settings.mute === true &&
            (muteUntilMs == null || muteUntilMs > Date.now());

          callback(null, { isMuted, mutedUntil: muteUntilMs ?? 0 });
        } catch (err) {
          // Fail-open: an oracle failure must never suppress a push.
          logger.warn(`gRPC checkGroupMute error: ${String(err)}`);
          callback(null, { isMuted: false, mutedUntil: 0 });
        }
      })();
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
            sinceRevision: number | string; // int64 (string at runtime); -1 = not revision mode
          };

          const conversationType = String(
            req.conversationType ?? ""
          ).toUpperCase();
          // proto-loader delivers int64 since_seq as a STRING (longs: String).
          const sinceSeq = Number(req.sinceSeq ?? 0);
          const limit = Math.min(Math.max(req.limit || 100, 1), 200);

          // ZERO-LOSS revision cursor. The gateway sends -1 when the client did
          // NOT opt in (0 is a VALID cold-start cursor), so only >= 0 enables
          // revision mode — a raw request omitting the field (int64 default 0)
          // stays on the legacy since_seq axis. Mirrors communityCatchup.
          const sinceRevisionRaw = Number(req.sinceRevision);
          const sinceRevision =
            Number.isFinite(sinceRevisionRaw) && sinceRevisionRaw >= 0
              ? sinceRevisionRaw
              : undefined;

          const result =
            conversationType === "GROUP"
              ? await deps.groupMessageService.catchup({
                  roomId: req.conversationId,
                  userId: req.requesterId,
                  sinceSeq,
                  sinceRevision,
                  limit,
                })
              : await deps.privateMessageService.catchup({
                  roomId: req.conversationId,
                  userId: req.requesterId,
                  sinceSeq,
                  sinceRevision,
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
              // Mirrors communityCatchup — reconnect/reload hydration must carry
              // reaction state, else a reaction applied live vanishes the next
              // time the client catches up (reopen room, reload, reconnect).
              reactions: groupStoredReactions(
                (e as { reactions?: unknown }).reactions
              ),
              editedAt: editedAt instanceof Date ? editedAt.getTime() : 0,
              systemEvent: systemEvent ?? "",
              systemData: systemData ? JSON.stringify(systemData) : "",
              // Zero-loss CHANGE cursor per message.
              revision: (e as { revision?: number }).revision ?? 0,
            };
          });

          callback(null, {
            conversationId: req.conversationId,
            events,
            hasMore: result.hasMore,
            lastSeq: result.lastSeq,
            authorized: result.authorized,
            // Zero-loss revision-mode fields (0/false in since_seq mode).
            roomRevision: result.roomRevision,
            lastRevision: result.lastRevision,
            resetRequired: result.resetRequired,
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
            status?: string;
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
            status: req.status || undefined,
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
            status?: string;
            page?: number;
            limit?: number;
          };

          const limit = Math.min(Math.max(req.limit || 20, 1), 100);
          const skip = (Math.max(req.page || 1, 1) - 1) * limit;

          const result = await deps.adminGroupService.listGroupMembers({
            groupId: req.groupId ?? "",
            q: req.q || undefined,
            role: req.role || undefined,
            status: req.status || undefined,
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

    // Admin Group Moderation: disband a group as a platform admin.
    adminDisbandGroup: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as {
            groupId?: string;
            actorAdminId?: string;
          };
          const result = await deps.adminGroupService.disbandGroup(
            req.groupId ?? "",
            req.actorAdminId ?? ""
          );
          callback(null, result);
        } catch (err) {
          logger.error(`gRPC adminDisbandGroup error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },

    // Admin Group Moderation: group-side cascade of a permanent system ban —
    // owned groups CLOSED, every other membership ended. Never throws to the
    // caller: backoffice treats this leg as best-effort, so a partial failure
    // returns the ids that did succeed.
    adminApplySystemBan: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as {
            userId?: string;
            actorAdminId?: string;
            reason?: string;
          };
          const result = await deps.adminGroupService.adminApplySystemBan(
            req.userId ?? "",
            req.actorAdminId ?? "",
            req.reason || undefined
          );
          callback(null, {
            ok: true,
            closedGroupIds: result.closedGroupIds,
            removedGroupIds: result.removedGroupIds,
            errorCode: "",
          });
        } catch (err) {
          logger.error(`gRPC adminApplySystemBan error: ${String(err)}`);
          callback(null, {
            ok: false,
            closedGroupIds: [],
            removedGroupIds: [],
            errorCode: "CHAT_SYSTEM_BAN_CASCADE_FAILED",
          });
        }
      })();
    },

    // Admin Group Moderation: remove one member as a platform admin.
    adminRemoveGroupMember: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as {
            groupId?: string;
            userId?: string;
            actorAdminId?: string;
            reason?: string;
          };
          const result = await deps.adminGroupService.removeGroupMember({
            groupId: req.groupId ?? "",
            userId: req.userId ?? "",
            actorAdminId: req.actorAdminId ?? "",
            reason: req.reason || undefined,
          });
          callback(null, result);
        } catch (err) {
          logger.error(`gRPC adminRemoveGroupMember error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },

    // Admin Group Moderation: permanently ban one member from one group (owner
    // ban closes the whole group). Business failures come back as errorCode.
    adminBanGroupMember: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as {
            groupId?: string;
            userId?: string;
            actorAdminId?: string;
            reason?: string;
          };
          const result = await deps.adminGroupService.banGroupMember({
            groupId: req.groupId ?? "",
            userId: req.userId ?? "",
            actorAdminId: req.actorAdminId ?? "",
            reason: req.reason || undefined,
          });
          callback(null, result);
        } catch (err) {
          logger.error(`gRPC adminBanGroupMember error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },

    // Admin Group Moderation: lift a group ban.
    adminUnbanGroupMember: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as {
            groupId?: string;
            userId?: string;
            actorAdminId?: string;
          };
          const result = await deps.adminGroupService.unbanGroupMember({
            groupId: req.groupId ?? "",
            userId: req.userId ?? "",
            actorAdminId: req.actorAdminId ?? "",
          });
          callback(null, result);
        } catch (err) {
          logger.error(`gRPC adminUnbanGroupMember error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },

    // Admin Group Conversation viewer (backoffice-service only) — read-only,
    // membership-gate-free group history. before_seq cursor; same DTO shape as
    // adminGetCommunityMessages so the panel reuses one message model.
    adminGetGroupMessages: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as {
            groupId: string;
            cursor: string;
            limit: number;
          };
          const limit = req.limit || 30;
          const parsedSeq = req.cursor ? Number(req.cursor) : NaN;
          const seq = Number.isFinite(parsedSeq) ? parsedSeq : null;

          const page = await deps.groupMessageService.getMessagesForModeration({
            roomId: req.groupId,
            seq,
            limit,
          });

          // `page.items` are canonical enriched wire messages: attachments,
          // avatars and quote thumbnails are already presigned download URLs.
          callback(null, {
            messages: page.items.map((m) => {
              const content = (m.content ?? {}) as {
                text?: string;
                files?: unknown[];
                sticker?: Record<string, unknown>;
              };
              const baseFiles = Array.isArray(content.files) ? content.files : [];
              // Stickers live in content.sticker (outside files[]) — fold it in
              // so the admin transcript can render it via the shared attachment
              // view; presign URL is already resolved on read.
              const files = content.sticker
                ? [...baseFiles, content.sticker]
                : baseFiles;
              const firstFile = files[0] as Record<string, unknown> | undefined;
              const str = (v: unknown): string =>
                typeof v === "string" ? v : "";
              return {
                messageId: str(m.id),
                roomId: str(m.roomId),
                senderId: str(m.senderId),
                senderName: str(m.senderName),
                senderAvatar: str(m.senderAvatar),
                message: content.text ?? "",
                contentType: str(m.contentType) || "TEXT",
                mediaKey:
                  str(firstFile?.downloadUrl) ||
                  str(firstFile?.url) ||
                  str(firstFile?.objectKey),
                attachmentsJson: JSON.stringify(files),
                reactionsJson: JSON.stringify(
                  m.reactionGroups ?? m.reactions ?? []
                ),
                quoteDataJson: m.quoteData ? JSON.stringify(m.quoteData) : "",
                sentAt: Number(m.serverTs) || 0,
                systemMessageType: str(m.systemEvent),
                systemMetadata: m.systemData
                  ? JSON.stringify(m.systemData)
                  : "",
                isDeleted: Boolean(m.isDeleted),
              };
            }),
            nextCursor: page.nextCursor ?? "",
            hasMore: page.hasMore,
          });
        } catch (err) {
          logger.error(`gRPC adminGetGroupMessages error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },

    // Admin Calling: aggregate call stats over an optional date range. The
    // `calls` collection lives in chat-service's DB, so this RPC is the only
    // way the admin panel can see it.
    adminGetCallAnalytics: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as { fromDate?: string; toDate?: string };
          const result = await deps.callAnalyticsRepo.getAnalytics({
            from: parseAdminDate(req.fromDate) ?? null,
            to: parseAdminDate(req.toDate) ?? null,
          });
          callback(null, result);
        } catch (err) {
          logger.error(`gRPC adminGetCallAnalytics error: ${String(err)}`);
          callback(toGrpcCallbackError(err));
        }
      })();
    },

    // Admin Calling: live health counters. Doubles as the backoffice health
    // probe's ping, so it must stay cheap (two counts).
    adminGetCallHealth: (
      _call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const result = await deps.callAnalyticsRepo.getHealth();
          callback(null, result);
        } catch (err) {
          logger.error(`gRPC adminGetCallHealth error: ${String(err)}`);
          callback(toGrpcCallbackError(err));
        }
      })();
    },

    // Admin Calling: read the platform-wide kill-switch. Uncached read so the
    // admin panel always shows the persisted truth, not a node's cached view.
    adminGetCallingEnabled: (
      _call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const state = await deps.callFlagService.getState();
          callback(null, {
            enabled: state.enabled,
            updatedBy: state.updatedBy ?? "",
            updatedAt: state.updatedAt ? state.updatedAt.getTime() : 0,
          });
        } catch (err) {
          logger.error(`gRPC adminGetCallingEnabled error: ${String(err)}`);
          callback(toGrpcCallbackError(err));
        }
      })();
    },

    // Admin Calling: flip the platform-wide kill-switch. Blocks only NEW calls
    // — anything already connected keeps running.
    adminSetCallingEnabled: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as { enabled?: boolean; actorId?: string };
          const state = await deps.callFlagService.setEnabled(
            Boolean(req.enabled),
            req.actorId || null
          );
          callback(null, {
            enabled: state.enabled,
            updatedBy: state.updatedBy ?? "",
            updatedAt: state.updatedAt ? state.updatedAt.getTime() : 0,
          });
        } catch (err) {
          logger.error(`gRPC adminSetCallingEnabled error: ${String(err)}`);
          callback(toGrpcCallbackError(err));
        }
      })();
    },

    // Authorize a media download against chat-resource HISTORICAL membership.
    // media-service calls this because an object key encodes the uploader, not
    // the room the attachment belongs to. Deliberately looser than the guards
    // used for message send/read: the requester only needs to have EVER been
    // part of the resource, not be a CURRENTLY active participant/member — so
    // an attachment stays downloadable after an unfriend/leave/kick/ban
    // (Telegram/WhatsApp parity: history never breaks). A normal authz denial
    // is NOT a gRPC error — it returns { allowed: false }; only a thrown/failed
    // lookup distinguishes allowed vs. denied. Catch-all → allowed:false so a
    // transient/internal failure can never accidentally grant access
    // (fail-closed).
    checkMediaAccess: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        const req = call.request as {
          userId?: string;
          scope?: string;
          resourceId?: string;
        };
        const userId = req.userId ?? "";
        const resourceId = req.resourceId ?? "";
        const scope = String(req.scope ?? "").toUpperCase();

        try {
          switch (scope) {
            case "PRIVATE_CHAT":
              // A private room's `participants` array is fixed at creation and
              // is never pruned on unfriend/block, so this is already a
              // historical check — reused as-is.
              await assertPrivateParticipant(
                deps.privateRoomRepo,
                resourceId,
                userId
              );
              break;
            case "GROUP_CHAT": {
              const member = await deps.groupMemberRepo.findByRoomAndUser(
                resourceId,
                userId
              );
              if (!member) throw new ForbiddenError("CHAT_NOT_A_MEMBER");
              // A BAN revokes media access outright. Kick and ban both KEEP the
              // membership row and only mutate `status`, and this check was a
              // bare row-existence test — so a banned member kept downloading
              // every attachment in the group indefinitely. Mirrors the
              // COMMUNITY_CHAT rule below, where a ban already outranks
              // historical access.
              //
              // LEFT and KICKED are deliberately still allowed: group history is
              // historical-read by design (a kicked member reads up to
              // `kickedAt`), and revoking their media would break the history
              // they can legitimately still see.
              if (String(member.status).toUpperCase() === "BANNED") {
                throw new ForbiddenError("USER_BANNED");
              }
              break;
            }
            case "COMMUNITY_CHAT": {
              const member = await deps.roomMemberRepo.findByRoomAndUser(
                resourceId,
                userId
              );
              // BANNED blocks ALL media access — even media a non-member of a
              // PUBLIC community could fetch (same rule as
              // assertCommunityReadAccess: the ban outranks the PUBLIC
              // fallback).
              if (member?.status === "banned") {
                throw new ForbiddenError("USER_BANNED");
              }
              if (member?.status === "active") break;
              // No active membership (never joined, or left/removed) — mirror
              // assertCommunityReadAccess: a PUBLIC community's media is as
              // fetchable as its message history, which non-members can
              // already read. Only a PRIVATE (or unsynced/null) community
              // denies here, matching the read-access guard's fail-closed
              // default.
              const room = await deps.generalRoomRepo.findRoomById(resourceId);
              if (room?.communityType !== "PUBLIC") {
                throw new ForbiddenError("CHAT_NOT_A_MEMBER");
              }
              break;
            }
            default:
              callback(null, { allowed: false });
              return;
          }
          callback(null, { allowed: true });
        } catch (err) {
          // A denial (no historical membership row found) is the expected "no"
          // answer, not an RPC failure. Log at debug so an unexpected internal
          // error is still traceable without alarming on routine denials.
          // Either way the answer is fail-closed: allowed:false.
          logger.debug(
            `checkMediaAccess denied (scope=${scope}, user=${userId}, resource=${resourceId}): ${String(err)}`
          );
          callback(null, { allowed: false });
        }
      })();
    },

    // User Search: bulk-resolve existing PrivateRoom ids for a viewer across
    // many candidate peer userIds in one indexed query (participantsKey is
    // @unique) — avoids N+1 gRPC calls from user-service's search endpoint.
    resolvePrivateRooms: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as {
            viewerId?: string;
            peerUserIds?: string[];
          };
          const viewerId = req.viewerId ?? "";
          const peerIds = [...new Set((req.peerUserIds ?? []).filter(Boolean))];
          if (!viewerId || peerIds.length === 0) {
            callback(null, { matches: [] });
            return;
          }

          const keyToPeer = new Map(
            peerIds.map((peerId) => [
              buildParticipantsKey(viewerId, peerId),
              peerId,
            ])
          );
          const rooms = await deps.privateRoomRepo.findByParticipantsKeys([
            ...keyToPeer.keys(),
          ]);
          const matches = rooms
            .map((room) => {
              const peerId = keyToPeer.get(room.participantsKey);
              return peerId
                ? { peerUserId: peerId, roomId: room.roomId }
                : null;
            })
            .filter(
              (m): m is { peerUserId: string; roomId: string } => m !== null
            );

          callback(null, { matches });
        } catch (err) {
          logger.error(`gRPC resolvePrivateRooms error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },

    // User Search: capped list of the viewer's private-room peers (peerId +
    // roomId), used to classify search-matched users into "Chat" vs "Other".
    listPrivateRooms: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as { viewerId?: string; limit?: number };
          const viewerId = req.viewerId ?? "";
          const limit = Math.min(Math.max(req.limit || 300, 1), 1000);
          if (!viewerId) {
            callback(null, { rooms: [] });
            return;
          }
          const peers = await deps.privateRoomRepo.findPeersForUser(
            viewerId,
            limit
          );
          callback(null, {
            rooms: peers.map((p) => ({
              peerUserId: p.peerId,
              roomId: p.roomId,
            })),
          });
        } catch (err) {
          logger.error(`gRPC listPrivateRooms error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },

    // User Search: list/search groups for a viewer — ACTIVE (member),
    // OTHER (not an active member but the group is still in the viewer's
    // conversation list), or BY_IDS (resolve specific roomIds, e.g. to refresh
    // a recently-viewed group's metadata).
    //
    // Visibility rule, enforced here for every mode: a group is searchable ONLY
    // when the viewer is an ACTIVE member of it, OR the group still sits in the
    // viewer's own conversation list. Group existence — public, name-matching,
    // previously-joined, or a stale Recent row — never grants visibility. The
    // candidate id set therefore always comes from the viewer's own membership
    // rows (one query), never from an unbounded "every other group" scan.
    searchUserGroups: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as {
            viewerId?: string;
            q?: string;
            mode?: string;
            roomIds?: string[];
            limit?: number;
          };
          const viewerId = req.viewerId ?? "";
          const q = req.q || undefined;
          const mode = String(req.mode ?? "ACTIVE").toUpperCase();
          const roomIds = (req.roomIds ?? []).filter(Boolean);
          const limit = Math.min(Math.max(req.limit || 10, 1), 100);

          // Same membership source the unified inbox lists a group from
          // (ACTIVE + LEFT + KICKED, BANNED excluded) — one query, no per-group
          // lookup, so search visibility can never drift from what the user's
          // conversation list actually shows.
          const memberships = viewerId
            ? await deps.groupMemberRepo.getActiveOrLeftMemberships(viewerId)
            : [];
          const activeRoomIds = memberships
            .filter((m) => m.status === "ACTIVE")
            .map((m) => m.roomId);
          const activeSet = new Set(activeRoomIds);
          const clearedByRoom = new Map(
            memberships.map((m) => [m.roomId, m.clearedAt])
          );

          // Non-active viewer: the group stays visible only while the
          // conversation survives their own "Delete Conversation" cutoff —
          // the same `isVisibleAfterClear` gate GroupRoomService applies to
          // the inbox.
          const isSearchable = (g: {
            roomId: string;
            lastMessageAt: Date | null;
          }) => {
            if (activeSet.has(g.roomId)) return true;
            if (!clearedByRoom.has(g.roomId)) return false;
            const clearedAt = clearedByRoom.get(g.roomId) ?? null;
            if (!clearedAt) return true;
            return (g.lastMessageAt?.getTime() ?? 0) > clearedAt.getTime();
          };

          let rows;
          if (mode === "OTHER") {
            const excludeSet = new Set(roomIds);
            const candidateIds = memberships
              .map((m) => m.roomId)
              .filter((id) => !activeSet.has(id) && !excludeSet.has(id));
            rows = await deps.groupRoomRepo.searchInRoomIds(
              candidateIds,
              q,
              limit
            );
          } else if (mode === "BY_IDS") {
            rows = await deps.groupRoomRepo.findManyByRoomIds(roomIds);
          } else {
            rows = await deps.groupRoomRepo.searchInRoomIds(
              activeRoomIds,
              q,
              limit
            );
          }

          const groups = rows.filter(isSearchable).map((g) => ({
            roomId: g.roomId,
            name: g.name,
            avatar: g.avatar,
            description: g.description,
            memberCount: g.memberCount,
            isActiveMember: activeSet.has(g.roomId),
            lastMessageAt: g.lastMessageAt ? g.lastMessageAt.getTime() : 0,
            createdAt: g.createdAt.getTime(),
          }));

          callback(null, { groups });
        } catch (err) {
          logger.error(`gRPC searchUserGroups error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },

    // Auto-Connect (user-service): batch get-or-create private rooms for
    // a user against multiple peers. Returns existing roomId if one exists,
    // creates new one if not (and friendship is ACCEPTED).
    getOrCreatePrivateRooms: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as {
            userId?: string;
            peerUserIds?: string[];
          };
          const userId = req.userId ?? "";
          const peerIds = [...new Set((req.peerUserIds ?? []).filter(Boolean))];
          if (!userId || peerIds.length === 0) {
            callback(null, { rooms: [] });
            return;
          }

          const matches: { peerUserId: string; roomId: string }[] = [];
          for (const peerId of peerIds) {
            const room = await deps.privateRoomService.getOrCreateRoom(
              userId,
              peerId
            );
            if (room) {
              matches.push({ peerUserId: peerId, roomId: room.roomId });
            }
          }

          callback(null, { rooms: matches });
        } catch (err) {
          logger.error(`gRPC getOrCreatePrivateRooms error: ${String(err)}`);
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

          const [{ senderName, senderAvatar }, room] = await Promise.all([
            resolveSenderIdentity(
              deps.userSnapshotService,
              deps.cacheRepo,
              req.senderId
            ),
            deps.generalRoomRepo?.findRoomById(req.roomId),
          ]);
          const communityName = room?.name ?? "";

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

          // Suppress all live effects on a duplicate clientMessageId — the
          // original send already ran broadcast + activity + bump-to-top. Same
          // guard the private/group path uses (see line 225).
          const alreadySent = isIdempotentReplay(saved);
          if (!alreadySent) {
            const bcastSenderAvatar = await resolveMediaUrl(senderAvatar || "");
            const albumRows = getAlbumMessages(saved);
            for (const row of albumRows) {
              const rowSentAt =
                row.createdAt instanceof Date
                  ? row.createdAt.getTime()
                  : sentAt;
              const rowAttachments = Array.isArray(row.attachments)
                ? (row.attachments as MediaFileLike[])
                : [];
              const rowBcastFiles = await resolveContentFiles(rowAttachments);
              const rowAttRecords = rowAttachments as Array<
                Record<string, unknown>
              >;
              const rowLocation = rowAttRecords.find(
                (a) => String(a.type).toLowerCase() === "location"
              );
              const rowContact = rowAttRecords.find(
                (a) => String(a.type).toLowerCase() === "contact"
              );
              const rowSticker = rowAttRecords.find(
                (a) => String(a.type).toLowerCase() === "sticker"
              );
              // Resolve-on-read: quoteData.thumbnail objectKey → full download
              // URL for the broadcast, same contract as the sender avatar/
              // attachment files above (never persisted resolved).
              const rowQuote = buildCanonicalQuote(row.quoteData);
              const rowQuoteUrlMap = rowQuote?.thumbnail
                ? await resolveMediaUrlMap([rowQuote.thumbnail])
                : new Map<string, string>();
              publishRealtimeSafe(
                "community:" + req.communityId,
                "community:message:new",
                {
                  // Canonical shape shared with private/group message:new — see
                  // buildChatMessageEvent. Community-specific extras appended below.
                  ...buildChatMessageEvent({
                    id: row.id,
                    clientMessageId: req.clientMessageId ?? "",
                    roomId: row.roomId,
                    conversationType: "COMMUNITY",
                    senderId: row.sentBy,
                    senderName,
                    senderAvatar: bcastSenderAvatar,
                    messageType: row.messageType,
                    content: {
                      text: row.message ?? "",
                      files: rowBcastFiles,
                      ...(rowLocation ? { location: rowLocation } : {}),
                      ...(rowContact ? { contact: rowContact } : {}),
                      ...(rowSticker ? { sticker: rowSticker } : {}),
                    },
                    parentMessageId: row.parentMessageId ?? "",
                    quoteData: resolveQuoteThumbnail(rowQuote, rowQuoteUrlMap),
                    reactions: [],
                    serverTs: rowSentAt,
                    sequenceNumber: row.sequenceNumber,
                    countInUnread:
                      (row as unknown as { countInUnread?: boolean | null })
                        .countInUnread ?? true,
                  }),
                  communityId: req.communityId,
                  // Back-compat alias for existing FE consumers that read
                  // top-level `message` instead of `content.text`.
                  message: row.message ?? "",
                  // Zero-Loss Revision Axis: per-room change cursor (Telegram
                  // pts) — not produced by buildChatMessageEvent, community-only.
                  revision: (row as { revision?: number }).revision ?? 0,
                },
                `communityId=${req.communityId} roomId=${row.roomId} messageId=${row.id} sequenceNumber=${row.sequenceNumber}`
              );
            }

            const lastAttachments = Array.isArray(saved.attachments)
              ? (saved.attachments as Array<Record<string, unknown>>)
              : (parsed.files ?? []);
            const lastLocation = lastAttachments.find(
              (a) => String(a.type).toLowerCase() === "location"
            );
            const lastContact = lastAttachments.find(
              (a) => String(a.type).toLowerCase() === "contact"
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
                senderUserId: req.senderId,
                senderUsername: senderName,
                // Centralized preview — identical to the sibling community:updated
                // socket preview below, so non-text messages (media/sticker/
                // voice/document/location/contact) never persist a blank preview.
                messagePreview: convertMessageToPreview(saved.messageType, {
                  text: saved.message ?? "",
                  files: lastAttachments,
                  ...(lastLocation ? { location: lastLocation } : {}),
                  ...(lastContact ? { contact: lastContact } : {}),
                }),
                clientMessageId: req.clientMessageId ?? null,
                seq: saved.sequenceNumber ?? 0,
                contentType: normalizeMessageType(saved.messageType),
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
              senderName,
              lastMessageId: saved.id,
              lastMessageAt: sentAt,
              preview: {
                contentType: normalizeMessageType(saved.messageType),
                text: convertMessageToPreview(saved.messageType, {
                  text: saved.message ?? "",
                  files: lastAttachments,
                  ...(lastLocation ? { location: lastLocation } : {}),
                  ...(lastContact ? { contact: lastContact } : {}),
                }),
                // See the private/group bump above — `seq` is what lets the
                // client order two bumps that share a millisecond.
                clientMessageId: req.clientMessageId ?? null,
                seq: saved.sequenceNumber ?? 0,
                revision: saved.revision ?? 0,
                createdAt: sentAt,
              },
            });

            // FCM push — community messages need the same offline-wake push as
            // private/group. fetchRecipients is lazy so the DB call only runs
            // when RabbitMQ is configured.
            publishMessageSentSafe({
              conversationId: req.communityId,
              conversationType: "COMMUNITY",
              communityId: req.communityId,
              communityName,
              messageId: saved.id,
              clientMessageId: req.clientMessageId ?? "",
              senderId: req.senderId,
              senderName,
              senderAvatar,
              preview: buildPushPreview(saved.messageType, saved.message ?? ""),
              ...(pushImageKeyOf(saved.messageType, {
                files: lastAttachments,
              })
                ? {
                    previewImageKey: pushImageKeyOf(saved.messageType, {
                      files: lastAttachments,
                    }),
                  }
                : {}),
              messageType: normalizeMessageType(saved.messageType),
              sentAt,
              fetchRecipients: () =>
                deps.communityMessageService.getActiveMemberIds(req.roomId),
            });
          }

          callback(null, {
            messageId: saved.id,
            roomId: saved.roomId,
            sentAt,
            sequenceNumber: saved.sequenceNumber ?? 0,
          });
        } catch (err) {
          logger.error(`gRPC sendCommunityMessage error: ${String(err)}`);
          callback(toGrpcCallbackError(err));
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
          const [messages, pinnedMessage] = await Promise.all([
            deps.communityMessageService.getMessages({
              roomId: req.roomId,
              userId: req.requesterId,
              cursor: req.cursor || undefined,
              limit,
            }),
            deps.communityPinService.getActivePinSummary(
              req.roomId,
              req.requesterId
            ),
          ]);

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
              senderName: m.senderName ?? "",
              // senderAvatar is already resolved to a presigned URL by toWire
              senderAvatar:
                ((m as unknown as Record<string, unknown>)
                  .senderAvatar as string) ?? "",
              message: m.message ?? "",
              // getMessages now returns the wire shape: `contentType` is already
              // the canonical UPPER-CASE value (§1), so no re-normalize needed.
              contentType: m.contentType,
              mediaKey: (() => {
                const att = Array.isArray(m.attachments)
                  ? (m.attachments[0] as Record<string, unknown> | undefined)
                  : undefined;
                return (att?.url as string) ?? (att?.objectKey as string) ?? "";
              })(),
              // Full attachment array (URLs already resolved by toWire/applyUrlMapToFiles).
              // The api-gateway uses this to build content.files for the FE.
              attachmentsJson: Array.isArray(m.attachments)
                ? JSON.stringify(m.attachments)
                : "[]",
              reactionsJson: JSON.stringify(m.reactions ?? []),
              quoteDataJson: m.quoteData ? JSON.stringify(m.quoteData) : "",
              sentAt:
                m.createdAt instanceof Date
                  ? m.createdAt.getTime()
                  : Date.now(),
              systemMessageType:
                ((m as Record<string, unknown>).systemMessageType as string) ??
                "",
              // Proto field is a string — serialize the metadata map to JSON.
              systemMetadata: (() => {
                const meta = (m as Record<string, unknown>).systemMetadata;
                return meta ? JSON.stringify(meta) : "";
              })(),
              isPersonal: Boolean((m as Record<string, unknown>).isPersonal),
            })),
            nextCursor,
            hasMore,
            pinnedMessageJson: pinnedMessage
              ? JSON.stringify(pinnedMessage)
              : "",
          });
        } catch (err) {
          logger.error(`gRPC getCommunityMessages error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },

    // Admin Community Conversation viewer (backoffice-service only) — same
    // wire shape as getCommunityMessages, but reads via
    // getMessagesForModeration (no membership/PUBLIC gate).
    adminGetCommunityMessages: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as {
            roomId: string;
            cursor: string;
            limit: number;
          };

          const limit = req.limit || 30;
          const [page, pinnedMessage] = await Promise.all([
            deps.communityMessageService.getMessagesForModeration({
              roomId: req.roomId,
              cursor: req.cursor || undefined,
              limit,
            }),
            deps.communityPinService.getActivePinSummary(req.roomId, ""),
          ]);

          // Both come straight from the keyset page. Deriving hasMore from
          // `messages.length >= limit` would be wrong in both directions: a
          // short page after DB filtering is not the end of history, and an
          // exactly-full page is not proof there is more.
          const messages = page.items;
          const nextCursor = page.nextCursor ?? "";
          const hasMore = page.hasMore;

          // content.sticker is not resolved by community toWire (unlike group's
          // enrichForWire path); presign each here so the admin panel gets a
          // usable download URL alongside the folded attachments entry.
          const stickerFor = async (
            m: Record<string, unknown>,
          ): Promise<Record<string, unknown> | null> => {
            const raw = (m.content as { sticker?: Record<string, unknown> } | undefined)
              ?.sticker;
            if (!raw || typeof raw !== "object") return null;
            const key = fileMediaKey(raw as MediaFileLike);
            const url = key ? await resolveMediaUrl(key) : "";
            return url ? { ...raw, url } : raw;
          };
          const stickers = await Promise.all(
            messages.map((m) => stickerFor(m as unknown as Record<string, unknown>)),
          );

          callback(null, {
            messages: messages.map((m, idx) => ({
              messageId: m.id,
              roomId: m.roomId,
              senderId: m.sentBy,
              senderName: m.senderName ?? "",
              senderAvatar:
                ((m as unknown as Record<string, unknown>)
                  .senderAvatar as string) ?? "",
              message: m.message ?? "",
              contentType: m.contentType,
              mediaKey: (() => {
                const att = Array.isArray(m.attachments)
                  ? (m.attachments[0] as Record<string, unknown> | undefined)
                  : undefined;
                return (att?.url as string) ?? (att?.objectKey as string) ?? "";
              })(),
              attachmentsJson: (() => {
                const base = Array.isArray(m.attachments) ? m.attachments : [];
                const sticker = stickers[idx];
                const merged = sticker ? [...base, sticker] : base;
                return JSON.stringify(merged);
              })(),
              reactionsJson: JSON.stringify(m.reactions ?? []),
              quoteDataJson: m.quoteData ? JSON.stringify(m.quoteData) : "",
              sentAt:
                m.createdAt instanceof Date
                  ? m.createdAt.getTime()
                  : Date.now(),
              systemMessageType:
                ((m as Record<string, unknown>).systemMessageType as string) ??
                "",
              systemMetadata: (() => {
                const meta = (m as Record<string, unknown>).systemMetadata;
                return meta ? JSON.stringify(meta) : "";
              })(),
              isPersonal: Boolean((m as Record<string, unknown>).isPersonal),
            })),
            nextCursor,
            hasMore,
            pinnedMessageJson: pinnedMessage
              ? JSON.stringify(pinnedMessage)
              : "",
          });
        } catch (err) {
          logger.error(`gRPC adminGetCommunityMessages error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },

    getCommunityMessageById: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as { roomId: string; messageId: string };
          const snap = await deps.communityMessageService.getModerationSnapshot(
            {
              roomId: req.roomId,
              messageId: req.messageId,
            }
          );
          // camelCase keys (proto-loader keepCase:false maps object_key→objectKey …).
          callback(null, {
            found: snap.found,
            message: snap.message,
            contentType: snap.contentType,
            sentAt: snap.sentAt,
            senderId: snap.senderId,
            media: snap.media,
          });
        } catch (err) {
          logger.error(`gRPC getCommunityMessageById error: ${String(err)}`);
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
              firstUnreadMessageId: s.firstUnreadMessageId ?? "",
              hasLastMessage: s.hasLastMessage,
              perUserResolved: s.perUserResolved,
              lastMessage: s.lastMessage
                ? {
                    username: s.lastMessage.username,
                    message: s.lastMessage.message,
                    dateTime: s.lastMessage.dateTime,
                    isSystem: s.lastMessage.isSystem,
                    userId: s.lastMessage.userId,
                  }
                : undefined,
              // Viewer-private join line ("You joined the community"); sender-less.
              personalLastMessage: s.personalLastMessage
                ? {
                    username: "",
                    message: s.personalLastMessage.message,
                    dateTime: s.personalLastMessage.dateTime,
                    isSystem: true,
                    userId: "",
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
            sinceRevision: number | string; // int64 (string at runtime); -1 = not revision mode
          };

          // sinceTs is an int64 (a string at runtime via proto-loader) — coerce
          // to a number before constructing the Date, else new Date("<digits>")
          // parses as a date string and yields an Invalid Date.
          const sinceTsMs = Number(req.sinceTs);
          const sinceTs =
            Number.isFinite(sinceTsMs) && sinceTsMs > 0
              ? new Date(sinceTsMs)
              : undefined;

          // ZERO-LOSS revision cursor (highest precedence). proto-loader delivers
          // int64 as a string. The gateway sends -1 when the client did NOT opt
          // into revision mode (0 is a VALID cold-start cursor), so only >= 0
          // enables revision mode. A raw request that omits the field (int64
          // default 0) is treated as legacy id/ts to preserve back-compat.
          const sinceRevisionRaw = Number(req.sinceRevision);
          const sinceRevision =
            Number.isFinite(sinceRevisionRaw) && sinceRevisionRaw >= 0
              ? sinceRevisionRaw
              : undefined;

          const result = await deps.communityMessageService.catchup({
            roomId: req.roomId,
            userId: req.requesterId,
            sinceId: req.sinceId || "",
            sinceTs,
            sinceRevision,
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
                // Zero-loss CHANGE cursor per message.
                revision: (m as { revision?: number }).revision ?? 0,
                systemMessageType:
                  (m as Record<string, unknown>).systemMessageType ?? null,
                systemMetadata:
                  (m as Record<string, unknown>).systemMetadata ?? null,
              };
            }),
            hasMore: result.hasMore,
            lastId: result.lastId,
            authorized: result.authorized,
            nextTs: result.nextTs,
            // Zero-loss revision-mode fields (0/false in id/ts modes).
            roomRevision: result.roomRevision,
            lastRevision: result.lastRevision,
            resetRequired: result.resetRequired,
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
            emoji: req.emoji,
          });

          // reactToMessage already resolves avatar URLs before returning, so
          // result.reactions carries full presigned avatarUrls — no extra pass needed.
          await redis.publish(
            `community:${result.roomId}`,
            JSON.stringify({
              event: "community:message:reaction",
              data: {
                messageId: result.messageId,
                communityId: result.roomId,
                reactions: result.reactions,
                revision: result.revision,
              },
            })
          );

          const ackPayload = {
            messageId: result.messageId,
            communityId: result.roomId,
            reactions: result.reactions.map((g) => ({
              emoji: g.emoji,
              count: g.count,
              users: g.users.map((u) => ({
                userId: u.userId,
                displayName: u.displayName,
                avatarUrl: u.avatarUrl,
              })),
            })),
          };
          // Reactions are a fully separate OVERLAY — never touching the
          // canonical lastActivity columns. Mirrors the REST reactToMessage
          // handler (community-message.controller.ts) exactly.
          const isSelfReaction = result.targetUserId === req.userId;

          if (result.added) {
            const reactedAt = Date.now();
            const { selfPreview, targetPreview } = buildReactionActivityText({
              actorName: result.actorName,
              targetMessagePreview: result.targetMessagePreview,
              emoji: req.emoji,
              isSelfReaction,
            });
            publishCommunityActivitySafe({
              communityId: req.communityId,
              lastMessageAt: new Date(reactedAt).toISOString(),
              lastMessageId: req.messageId,
              senderUserId: req.userId,
              senderUsername: result.actorName,
              messagePreview: "",
              type: "reaction_added",
              reactionMessageId: req.messageId,
              reactionEmoji: req.emoji,
              reactionActorId: req.userId,
              reactionActorPreview: selfPreview,
              reactionTargetId: isSelfReaction ? null : result.targetUserId,
              reactionTargetPreview: isSelfReaction ? null : targetPreview,
            });

            // Synchronous companion — awaited BEFORE the gRPC ack, same
            // reasoning as the REST handler: a caller that reloads right
            // after receiving this response must never race ahead of the
            // DB write. The queue publish above remains the backstop on
            // failure/timeout.
            await getCommunityReconcileClient().updateReactionActivity({
              communityId: req.communityId,
              added: true,
              messageId: req.messageId,
              emoji: req.emoji,
              actorId: req.userId,
              actorPreview: selfPreview,
              targetId: isSelfReaction ? null : result.targetUserId,
              targetPreview: isSelfReaction ? null : targetPreview,
              reactedAt,
            });
            callback(null, ackPayload);

            // Live bump — restricted to just the actor (+ target, if a
            // different person), same reasoning as the REST handler.
            publishCommunityUpdatedSafe({
              redis,
              communityId: req.communityId,
              roomId: result.roomId,
              fetchMembers: () =>
                Promise.resolve(
                  isSelfReaction
                    ? [req.userId]
                    : [req.userId, result.targetUserId]
                ),
              senderId: req.userId,
              senderName: "",
              lastMessageId: req.messageId,
              lastMessageAt: reactedAt,
              preview: { contentType: "SYSTEM", text: selfPreview },
              subjectUserId: req.userId,
              selfPreview,
              // Preview-only: a reaction never writes the canonical
              // `lastActivityAt` the list sorts on, so its bump must not move
              // the row either — it only repaints the subtitle.
              activityOnly: true,
              ...(isSelfReaction
                ? {}
                : {
                    resolveOverrides: () =>
                      Promise.resolve(
                        new Map([
                          [
                            result.targetUserId,
                            {
                              lastMessageId: req.messageId,
                              lastMessageAt: reactedAt,
                              senderId: req.userId,
                              senderName: result.actorName,
                              preview: {
                                contentType: "SYSTEM",
                                text: targetPreview,
                              },
                            },
                          ],
                        ])
                      ),
                  }),
            });
          } else {
            // Removed — clear the overlay IF this exact reaction is the one
            // currently shown (identity match is authoritative in
            // community-service; a no-op otherwise).
            publishCommunityActivitySafe({
              communityId: req.communityId,
              lastMessageAt: new Date().toISOString(),
              lastMessageId: req.messageId,
              senderUserId: req.userId,
              senderUsername: result.actorName,
              messagePreview: "",
              type: "reaction_removed",
              reactionMessageId: req.messageId,
              reactionEmoji: req.emoji,
              reactionActorId: req.userId,
            });

            // Synchronous companion — see the ADD branch's comment above.
            await getCommunityReconcileClient().updateReactionActivity({
              communityId: req.communityId,
              added: false,
              messageId: req.messageId,
              emoji: req.emoji,
              actorId: req.userId,
            });
            callback(null, ackPayload);

            // Same reasoning as the REST handler (community-message.controller.ts):
            // this MUST go through `resolveOverrides` with a fresh `Date.now()`
            // timestamp, not the reverted message's own (older) `createdAt` —
            // otherwise a client that only applies a bump when it's newer than
            // what it already has (the reaction's own `now()` bump) silently
            // drops this revert, leaving the removed reaction stuck on screen.
            // The override branch also forces `unread:false`, since this is a
            // revert of already-seen content, never a new message.
            void deps.communityMessageService
              .getLatestRealActivityForLiveBump(result.roomId)
              .then((recalc) => {
                if (!recalc.hasLastMessage) return;
                const revertAt = Date.now();
                const revertBump = {
                  lastMessageId: recalc.prevMessageId ?? "",
                  lastMessageAt: revertAt,
                  senderId: recalc.sentBy,
                  senderName: recalc.senderName,
                  preview: {
                    contentType: normalizeMessageType(recalc.messageType),
                    text: recalc.preview,
                  },
                };
                const recipients = isSelfReaction
                  ? [req.userId]
                  : [req.userId, result.targetUserId];
                publishCommunityUpdatedSafe({
                  redis,
                  communityId: req.communityId,
                  roomId: result.roomId,
                  fetchMembers: () => Promise.resolve(recipients),
                  senderId: recalc.sentBy,
                  senderName: recalc.senderName,
                  lastMessageId: revertBump.lastMessageId,
                  lastMessageAt: revertAt,
                  preview: revertBump.preview,
                  // Same as the add: repaint the subtitle back to the real last
                  // message without moving the row (the row never moved).
                  activityOnly: true,
                  resolveOverrides: () =>
                    Promise.resolve(
                      new Map(recipients.map((id) => [id, revertBump]))
                    ),
                });
              })
              .catch((err: unknown) => {
                logger.warn(
                  `reactToCommunityMessage|getLatestRealActivityForLiveBump failed roomId=${result.roomId}: ${String(err)}`
                );
              });
          }
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
          const editedAtMs =
            result.editedAt instanceof Date
              ? result.editedAt.getTime()
              : Date.now();
          await redis.publish(
            `community:${result.roomId}`,
            JSON.stringify({
              event: "community:message:edited",
              data: {
                messageId: result.id,
                communityId: result.roomId,
                roomId: result.roomId,
                senderId: result.sentBy,
                message: result.message ?? "",
                contentType: normalizeMessageType(result.messageType),
                isEdited: true,
                editedAt: editedAtMs,
                revision: (result as { revision?: number }).revision ?? 0,
              },
            })
          );
          callback(null, {
            messageId: result.id,
            communityId: result.roomId,
            roomId: result.roomId,
            isEdited: true,
            editedAt: editedAtMs,
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
                // Only delete-for-everyone bumps the room revision (§8).
                ...(req.deleteType === "forEveryone"
                  ? {
                      revision: (result as { revision?: number }).revision ?? 0,
                    }
                  : {}),
              },
            })
          );

          // Keep pin state consistent with the delete — the same hook the REST
          // delete controller runs, so the socket path can't leave a pin behind
          // that REST would have cleared. See lib/pin-after-delete.
          //
          // AWAITED, and BEFORE the lastActivity recalculation below: the hook
          // can RETRACT the "<actor> pinned a message" system line, which is
          // itself a room message and is very often the room's current last
          // one. A recalc that raced it would re-point lastActivity at a line
          // about to be tombstoned, and the community list would preview a
          // deleted message forever. `unpinAfterDelete` never throws.
          if (result?.roomId) {
            await unpinAfterDelete({
              redis,
              pinService: deps.communityPinService,
              kind: "COMMUNITY",
              roomId: result.roomId,
              communityId: req.communityId,
              messageId: req.messageId,
              userId: req.userId,
              scope: req.deleteType === "forEveryone" ? "forEveryone" : "forMe",
            });
          }

          // lastActivity recalculation MUST complete (including the
          // synchronous community-service confirmation below) BEFORE the ack
          // — mirrors reactToMessage's guaranteed-before-response pattern.
          // Previously this ran AFTER callback(), so a client that re-fetched
          // GET /communities/mine immediately on receiving the delete
          // response could race ahead of the (fire-and-forget, no-DLQ) async
          // community.activity.queue publish and see stale lastActivity.
          let forEveryoneRecalc: Awaited<
            ReturnType<
              typeof deps.communityMessageService.recalculateLastMessageAfterDelete
            >
          > = null;
          let forMeRecalc: Awaited<
            ReturnType<
              typeof deps.communityMessageService.recalculateLastMessageAfterDeleteForMe
            >
          > = null;

          // delete-for-everyone: recalculate and persist to community-service.
          if (req.deleteType === "forEveryone" && result?.roomId) {
            forEveryoneRecalc =
              await deps.communityMessageService.recalculateLastMessageAfterDelete(
                result.roomId,
                req.messageId
              );
            if (forEveryoneRecalc !== null) {
              // Persist the ROLLED-BACK activity — the previous visible
              // message's own timestamp, never the deletion's. Shared with the
              // REST delete path (events/community-last-activity.ts).
              await reconcileCommunityLastActivityAfterDelete({
                communityId: req.communityId,
                recalc: forEveryoneRecalc,
                removedAt: result?.createdAt,
              });
            } else if (result?.createdAt) {
              // The SHARED snapshot did not move — but a member who had hidden
              // everything newer than the removed message was previewing IT.
              // See events/publish-effective-last-loss.ts.
              const lRoomId = result.roomId;
              await publishCommunityEffectiveLastLoss({
                redis,
                communityId: req.communityId,
                roomId: lRoomId,
                memberIds: () =>
                  deps.communityMessageService.getActiveMemberIds(lRoomId),
                deletedMessageId: req.messageId,
                deletedMessageCreatedAt: result.createdAt,
                resolveLosers: (rid, at, ids) =>
                  deps.communityMessageService.resolveEffectiveLastLosers(
                    rid,
                    at,
                    ids
                  ),
              });
            }
          }

          // delete-for-me: personalize the deleting user's own view only.
          // Shared snapshot and canonical community-service lastActivity are
          // NOT changed — every other member is unaffected. The self-hide
          // overlay (lastActivityUserId/lastActivitySelfPreview) is the only
          // path that persists this, since the async queue never carries it.
          if (req.deleteType !== "forEveryone" && result?.roomId) {
            forMeRecalc =
              await deps.communityMessageService.recalculateLastMessageAfterDeleteForMe(
                result.roomId,
                result.createdAt,
                req.userId
              );
            if (forMeRecalc !== null && forMeRecalc.wasEffectiveLast) {
              await getCommunityReconcileClient().updateMessageActivity({
                communityId: req.communityId,
                selfUserId: req.userId,
                selfPreview: forMeRecalc.preview,
              });
            }
          }

          callback(null, {
            messageId: result?.id ?? req.messageId,
            communityId: req.communityId,
            roomId: result?.roomId ?? "",
            deleteType: req.deleteType,
          });

          // Realtime socket bump — fire-and-forget, AFTER the ack (matches
          // reactToMessage's ordering: the DB write is guaranteed by now, the
          // live push is best-effort on top of it).
          if (forEveryoneRecalc !== null && result?.roomId) {
            const fRoomId = result.roomId;
            const recalc = forEveryoneRecalc;
            publishCommunityUpdatedSafe({
              redis,
              communityId: req.communityId,
              roomId: fRoomId,
              fetchMembers: () =>
                deps.communityMessageService.getActiveMemberIds(fRoomId),
              // Per-recipient correctness on the LIVE socket delete path (the
              // gateway routes community:message:delete through this gRPC
              // handler): a member who personally hid the new shared
              // previous-visible message gets THEIR own preview, mirroring REST.
              resolveOverrides: (memberIds) =>
                deps.communityMessageService
                  .resolveForEveryoneOverrides(
                    fRoomId,
                    recalc.prevMessageId,
                    memberIds
                  )
                  .then((raw) => renderCommunityOverrides(raw)),
              // Authoritative per-member badge correction (the derived count
              // already excludes the tombstone; nothing told the cached rows).
              ...(result
                ? {
                    resolveUnreadDeltas: (memberIds: string[]) =>
                      deps.communityMessageService.resolveUnreadDeltasAfterDelete(
                        { roomId: fRoomId, memberIds, deletedMessage: result }
                      ),
                  }
                : {}),
              // Without this the bump is discarded by the client's monotonic
              // list guard — it points BACKWARD at the previous visible message.
              deleteRecalc: true,
              deleteRecalcId: req.messageId,
              senderId: recalc.sentBy,
              senderName: recalc.senderName,
              lastMessageId: recalc.prevMessageId ?? "",
              lastMessageAt: bumpTimestampAfterDelete(recalc),
              preview: {
                contentType: normalizeMessageType(recalc.messageType),
                text: recalc.preview,
              },
            });
          }
          if (
            forMeRecalc !== null &&
            forMeRecalc.wasEffectiveLast &&
            result?.roomId
          ) {
            const recalc = forMeRecalc;
            const mRoomId = result.roomId;
            const hidden = result;
            publishCommunityUpdatedSafe({
              redis,
              communityId: req.communityId,
              roomId: mRoomId,
              fetchMembers: () => Promise.resolve([req.userId]),
              // Only the hiding user's own badge can move on a delete-for-me.
              resolveUnreadDeltas: (memberIds) =>
                deps.communityMessageService.resolveUnreadDeltasAfterDelete({
                  roomId: mRoomId,
                  memberIds,
                  deletedMessage: hidden,
                  onlyUserId: req.userId,
                }),
              deleteRecalc: true,
              deleteRecalcId: req.messageId,
              senderId: recalc.sentBy,
              senderName: recalc.senderName,
              lastMessageId: recalc.prevMessageId ?? "",
              // NEVER Date.now(): an emptied row must sort to the BOTTOM, not
              // jump to the top. See bumpTimestampAfterDelete's contract.
              lastMessageAt: bumpTimestampAfterDelete(recalc),
              preview: {
                contentType: normalizeMessageType(recalc.messageType),
                text: recalc.preview,
              },
            });
          }
        } catch (err) {
          logger.error(`gRPC deleteCommunityMessage error: ${String(err)}`);
          callback(toGrpcCallbackError(err));
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
          // Route through CommunityPinService (canonical store: CommunityMessagePin)
          const result = await deps.communityPinService.pin({
            messageId: req.messageId,
            userId: req.userId,
            roomId: req.roomId,
            communityId: req.communityId,
          });
          if (!result.idempotent) {
            // Switching pins: tell clients the previous message was unpinned
            // (same event `unpinCommunityMessage` publishes) before announcing
            // the new pin, so a listening client never sees two pins at once.
            if (result.replacedPin) {
              await redis.publish(
                `community:${req.communityId}`,
                JSON.stringify({
                  event: "community:message:unpinned",
                  data: {
                    communityId: req.communityId,
                    roomId: req.roomId,
                    messageId: result.replacedPin.messageId,
                    pin: result.replacedPin,
                    pinnedCount: null,
                  },
                })
              );
            }
            await redis.publish(
              `community:${req.communityId}`,
              JSON.stringify({
                event: "community:message:pinned",
                data: {
                  communityId: req.communityId,
                  roomId: req.roomId,
                  pin: result.pin,
                  pinnedCount: result.pinnedCount,
                },
              })
            );
          }
          callback(null, {
            messageId: req.messageId,
            communityId: req.communityId,
            roomId: req.roomId,
            pinnedCount: result.pinnedCount,
          });
        } catch (err) {
          logger.error(`gRPC pinCommunityMessage error: ${String(err)}`);
          callback(toGrpcCallbackError(err));
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
          // Route through CommunityPinService (soft-delete, no UNPINNED_MESSAGE)
          const result = await deps.communityPinService.unpin({
            messageId: req.messageId,
            userId: req.userId,
            roomId: req.roomId,
          });
          await redis.publish(
            `community:${req.communityId}`,
            JSON.stringify({
              event: "community:message:unpinned",
              data: {
                communityId: req.communityId,
                roomId: req.roomId,
                messageId: req.messageId,
                pin: result.pin,
                pinnedCount: result.pinnedCount,
              },
            })
          );
          callback(null, {
            messageId: req.messageId,
            communityId: req.communityId,
            roomId: req.roomId,
            pinnedCount: result.pinnedCount,
          });
        } catch (err) {
          logger.error(`gRPC unpinCommunityMessage error: ${String(err)}`);
          callback(toGrpcCallbackError(err));
        }
      })();
    },

    markCommunityMessageRead: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as {
            communityId: string;
            roomId: string;
            readerId: string;
            upToMessageId: string;
          };
          const result = await deps.communityMessageService.markMessageRead({
            communityId: req.communityId,
            roomId: req.roomId || req.communityId,
            readerId: req.readerId,
            upToMessageId: req.upToMessageId,
          });
          callback(null, result);
        } catch (err) {
          logger.error(`gRPC markCommunityMessageRead error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },

    getCommunityMessageReactions: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as {
            messageId: string;
            communityId: string;
            requesterId: string;
          };
          const result = await deps.communityMessageService.getMessageReactions(
            {
              messageId: req.messageId,
              communityId: req.communityId,
              requesterId: req.requesterId,
            }
          );
          callback(null, {
            messageId: result.messageId,
            communityId: result.communityId,
            reactions: result.reactions.map((g) => ({
              emoji: g.emoji,
              count: g.count,
              users: g.users.map((u) => ({
                userId: u.userId,
                displayName: u.displayName,
                avatar: u.avatar,
              })),
            })),
          });
        } catch (err) {
          logger.error(
            `gRPC getCommunityMessageReactions error: ${String(err)}`
          );
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },

    forwardCommunityMessage: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as {
            sourceMessageId: string;
            sourceCommunityId: string;
            targetCommunityId: string;
            targetRoomId: string;
            senderId: string;
            clientMessageId: string;
          };
          const result = await deps.communityMessageService.forwardMessage({
            sourceMessageId: req.sourceMessageId,
            sourceCommunityId: req.sourceCommunityId,
            targetCommunityId: req.targetCommunityId,
            targetRoomId: req.targetRoomId || req.targetCommunityId,
            senderId: req.senderId,
            clientMessageId: req.clientMessageId,
          });
          callback(null, result);
        } catch (err) {
          logger.error(`gRPC forwardCommunityMessage error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },

    markCommunityMessageDelivered: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as {
            communityId: string;
            roomId: string;
            recipientId: string;
            upToMessageId: string;
          };
          const result =
            await deps.communityMessageService.markMessageDelivered({
              communityId: req.communityId,
              roomId: req.roomId || req.communityId,
              recipientId: req.recipientId,
              upToMessageId: req.upToMessageId,
            });
          callback(null, result);
        } catch (err) {
          logger.error(
            `gRPC markCommunityMessageDelivered error: ${String(err)}`
          );
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
          let parsedNavigation: unknown;
          let parsedActorSnapshot: unknown;
          try {
            if (data.navigation) parsedNavigation = JSON.parse(data.navigation);
          } catch {
            /* skip */
          }
          try {
            if (data.actorSnapshot)
              parsedActorSnapshot = JSON.parse(data.actorSnapshot);
          } catch {
            /* skip */
          }
          // referenceId/entityId carried in data (if present) populate `entity`
          // so existing inbox queries that filter on entity.id keep working.
          // Fall back to communityId last so community notifications that carry
          // only `data.communityId` (e.g. member_kicked / member_banned /
          // community_deleted) still expose the id as `referenceId` on the
          // notification:new socket DTO — the client uses it to drop the
          // community from the sidebar without a hard refresh. Lowest priority,
          // so an explicit entityId/referenceId always wins.
          const entityId =
            data.entityId ?? data.referenceId ?? data.communityId ?? "";

          const rowActorId = req.actorId ?? "";
          const rowActorSnapshot =
            parsedActorSnapshot && typeof parsedActorSnapshot === "object"
              ? parsedActorSnapshot
              : {};

          // Stable identity of the underlying entity/action. Two events about
          // the same real-world thing (request → accepted, duplicate redelivery
          // of one event) share a groupKey, so the second one transitions the
          // existing row instead of stacking a second card. This replaces the
          // per-type friend.accepted / friend.rejected / friend.cancelled
          // special-cases that used to live here.
          const groupKey = resolveGroupKey(req.type, req.actorId, data);
          const existing = groupKey
            ? await deps.notificationRepo.findActiveByGroupKey(
                req.userId,
                groupKey
              )
            : null;

          const publishRow = async (
            event: string,
            row: Awaited<ReturnType<typeof deps.notificationRepo.create>>
          ) => {
            try {
              const unreadCount = await deps.notificationRepo.getUnreadCount(
                req.userId as string
              );
              const dto = await serializeNotification(
                row,
                req.userId as string
              );
              const {
                excludeSessionId: _excl,
                markRead: _markRead,
                ...clientData
              } = data;
              await publishUserSocketEvent(
                redis,
                req.userId as string,
                event,
                {
                  ...dto,
                  notificationId: row.id,
                  userId: req.userId,
                  createdAt: row.createdAt.getTime(),
                  updatedAt: row.updatedAt.getTime(),
                  // Login Detected only. Sent as epoch ms like the other two
                  // timestamps (the DTO carries a Date, which would otherwise
                  // go out as an ISO string over the socket) so a client can
                  // start its countdown straight from the live event without a
                  // follow-up fetch.
                  ...(row.loginExpiresAt
                    ? { expiresAt: row.loginExpiresAt.getTime() }
                    : {}),
                  ...(parsedNavigation !== undefined
                    ? { navigation: parsedNavigation }
                    : {}),
                  ...(Object.keys(clientData).length > 0
                    ? { data: clientData }
                    : {}),
                  unreadCount,
                },
                data.excludeSessionId
              );
              await publishUserSocketEvent(
                redis,
                req.userId as string,
                "notification:count_update",
                { count: unreadCount, unreadCount }
              );
            } catch (err) {
              logger.warn(
                `notify realtime publish failed for ${req.userId}: ${String(err)}`
              );
            }
          };

          // `CREATE` here means "the matched row belongs to a previous cycle of
          // a recycled id" — fall through to the insert below so the client gets
          // a genuine `notification:new`, leaving the old card as history.
          const plan = existing
            ? resolveTransition(existing.type, req.type, data)
            : null;

          if (existing && plan && plan.action !== "CREATE") {
            const existingPayload = (existing.payload ?? {}) as {
              title?: string;
              body?: string;
              data?: Record<string, string>;
            };

            if (plan.action === "DELETE") {
              // The WHOLE group goes, not just the row `findActiveByGroupKey`
              // happened to return: a friendship id is recycled across cycles,
              // so older cards for the same pair share this groupKey and would
              // otherwise outlive the request they describe. `groupKey` is
              // non-null here — `existing` only exists when it is.
              const { ids } =
                await deps.notificationRepo.deleteActiveByGroupKey(
                  req.userId,
                  groupKey as string
                );
              if (ids.length > 0) {
                const remainingUnread =
                  await deps.notificationRepo.getUnreadCount(req.userId);
                try {
                  // One event per row: clients key their local removal on
                  // notificationId, so a single event would strand the rest.
                  for (const deletedId of ids) {
                    await publishUserSocketEvent(
                      redis,
                      req.userId,
                      "notification:deleted",
                      {
                        notificationId: deletedId,
                        groupKey,
                        unreadCount: remainingUnread,
                      }
                    );
                  }
                  await publishUserSocketEvent(
                    redis,
                    req.userId,
                    "notification:count_update",
                    { count: remainingUnread, unreadCount: remainingUnread }
                  );
                } catch (err) {
                  logger.warn(
                    `notify:deleted publish failed for ${req.userId}: ${String(err)}`
                  );
                }
              }
              callback(null, { id: existing.id });
              return;
            }

            const mergedData = { ...(existingPayload.data ?? {}), ...data };
            // A resolved card states its CURRENT state in one sentence — the newest
            // copy always wins. Stacking an outcome line under the original request
            // ("X has sent you a friend request" / "You are now friends!") is what
            // made every resolved row read as two contradictory sentences.
            const nextTitle =
              req.title?.trim() || existingPayload.title?.trim() || "";
            const nextBody =
              req.body?.trim() || existingPayload.body?.trim() || "";

            const updated = await deps.notificationRepo.applyStateTransition(
              existing.id,
              {
                type: req.type,
                actorId: rowActorId || existing.actorId,
                actorSnapshot:
                  Object.keys(rowActorSnapshot).length > 0
                    ? rowActorSnapshot
                    : ((existing.actorSnapshot as object) ?? {}),
                entity: entityId
                  ? { id: entityId }
                  : ((existing.entity as object) ?? {}),
                payload: {
                  title: nextTitle,
                  body: nextBody,
                  data: mergedData,
                },
                resurface: plan.resurface,
              }
            );
            await publishRow("notification:updated", updated);
            callback(null, { id: updated.id });
            return;
          }

          // A terminal-removal event with nothing to remove is a no-op, never a new
          // card. Otherwise cancelling a request the recipient already actioned (or
          // a redelivered cancel) would MATERIALISE a "cancelled" notification out of
          // nothing — the exact duplicate-on-state-change this design exists to kill.
          if (isTerminalRemoval(req.type)) {
            callback(null, { id: "" });
            return;
          }

          const created = await deps.notificationRepo.create({
            userId: req.userId,
            actorId: rowActorId,
            type: req.type,
            entity: entityId ? { id: entityId } : {},
            actorSnapshot: rowActorSnapshot,
            payload: {
              title: req.title ?? "",
              body: req.body ?? "",
              data,
            },
            groupKey,
            // Producer-declared read-on-arrival. Call history uses it so your
            // OWN outgoing call, and a call you were present for, land as log
            // entries instead of badging you — only a call you never answered
            // arrives unread. It can only ever make a row LESS noisy, and it
            // travels in `data` like every other publish-time directive
            // (groupKey, resurface, excludeSessionId).
            ...(data.markRead === "true"
              ? { isRead: true, readAt: new Date() }
              : {}),
          });

          await publishRow("notification:new", created);

          callback(null, { id: created.id });
        } catch (err) {
          logger.error(`gRPC createNotification error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },

    getNotifications: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as {
            userId?: string;
            cursor?: string;
            limit?: number;
            sessionId?: string;
          };
          if (!req.userId) {
            callback({
              code: grpc.status.INVALID_ARGUMENT,
              message: "userId is required",
            });
            return;
          }

          const limit = Math.min(Math.max(req.limit ?? 20, 1), 100);
          const rows = await deps.notificationRepo.findByUserId(req.userId, {
            limit,
            cursor: req.cursor || null,
            viewerSessionId: req.sessionId || null,
          });
          const unreadCount = await deps.notificationRepo.getUnreadCount(
            req.userId,
            req.sessionId || null
          );

          // ONE serializer for the list, whichever transport asked for it.
          // This used to hand-roll its own row, and the two drifted: the socket
          // shape had no `category`, no `actor` block and therefore no
          // read-time avatar refresh (so it served presigned URLs that had
          // already expired), no `isDeleted`, and `data` flat instead of under
          // `payload`. That is two parsers on every client for one list.
          //
          // `notificationId`, `userId` and the flat `data` map are kept
          // alongside the canonical fields: renaming them would break every
          // client already reading this path, and emitting both costs nothing.
          const refresh = await resolveAvatarRefresh(rows);
          const notifications = await Promise.all(
            rows.map(async (n) => {
              const dto = await serializeNotification(
                n,
                req.userId as string,
                refresh
              );
              const rawData =
                ((n.payload ?? {}) as { data?: Record<string, string> }).data ??
                {};
              const row: Record<string, unknown> = {
                ...dto,
                // Dates over gRPC go out as epoch ms, matching the `/notify`
                // live events rather than the REST envelope's own conversion.
                createdAt: n.createdAt.getTime(),
                updatedAt: n.updatedAt.getTime(),
                // Legacy keys — kept for existing readers of this path.
                notificationId: n.id,
                userId: n.userId,
                referenceId: dto.referenceId ?? "",
                groupKey: dto.groupKey ?? "",
                data:
                  (dto.payload as { data?: Record<string, string> })?.data ??
                  {},
              };

              const friendship = await resolveNotificationFriendship(
                req.userId as string,
                n.type,
                rawData.friendshipId
              );
              if (friendship) row.friendship = friendship;

              return row;
            })
          );

          // Cursor pagination: full page → assume there is a next page, hand
          // back the oldest row's timestamp as the cursor (findByUserId pages
          // on createdAt < cursor).
          const hasMore = rows.length === limit;
          const nextCursor = hasMore
            ? rows[rows.length - 1].createdAt.toISOString()
            : "";

          callback(null, { notifications, nextCursor, hasMore, unreadCount });
        } catch (err) {
          logger.error(`gRPC getNotifications error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },

    markNotificationsRead: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as {
            userId?: string;
            notificationIds?: string[];
          };
          if (!req.userId) {
            callback({
              code: grpc.status.INVALID_ARGUMENT,
              message: "userId is required",
            });
            return;
          }

          const userId = req.userId;
          const ids = req.notificationIds ?? [];
          let updatedCount = 0;

          if (ids.length === 0) {
            // Empty list = mark ALL unread as read (count first so we can report
            // how many rows flipped).
            updatedCount = await deps.notificationRepo.getUnreadCount(userId);
            await deps.notificationRepo.markAllRead(userId);
          } else {
            // One owner-scoped updateMany, not N round-trips — a full-screen
            // "everything visible is now read" batch is a single Mongo op.
            updatedCount = await deps.notificationRepo.markManyRead(
              ids,
              userId
            );
          }

          const remainingUnread =
            await deps.notificationRepo.getUnreadCount(userId);
          callback(null, { updatedCount, remainingUnread });
        } catch (err) {
          logger.error(`gRPC markNotificationsRead error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },

    deleteNotification: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as {
            userId?: string;
            notificationId?: string;
          };
          if (!req.userId || !req.notificationId) {
            callback({
              code: grpc.status.INVALID_ARGUMENT,
              message: "userId and notificationId are required",
            });
            return;
          }

          const userId = req.userId;
          // Owner-scoped soft-delete (IDOR-safe): a non-owning id mutates
          // nothing and reports count 0. Idempotent — a re-delete also matches
          // 0 rows (isDeleted:false filter).
          const { count } = await deps.notificationRepo.deleteById(
            req.notificationId,
            userId
          );
          const deleted = count > 0;

          const remainingUnread =
            await deps.notificationRepo.getUnreadCount(userId);

          // Real-time bridge: relay the delete to the user's OTHER connected
          // devices so they drop the row too. The refreshed unread count is
          // emitted once by the gateway's notifications:delete handler (symmetric
          // with mark_read) — do NOT also publish count_update here or every
          // device receives it twice. Only relay when a row actually changed.
          // Best-effort: a relay error must never fail the delete.
          if (deleted) {
            try {
              await publishUserSocketEvent(
                redis,
                userId,
                "notification:deleted",
                {
                  notificationId: req.notificationId,
                  unreadCount: remainingUnread,
                }
              );
            } catch (err) {
              logger.warn(
                `notify delete publish failed for ${userId}: ${String(err)}`
              );
            }
          }

          callback(null, { deleted, remainingUnread });
        } catch (err) {
          logger.error(`gRPC deleteNotification error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },

    recordSessionAction: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      void (async () => {
        try {
          const req = call.request as {
            userId?: string;
            sessionId?: string;
            action?: string;
            body?: string;
          };
          if (!req.userId || !req.sessionId) {
            callback({
              code: grpc.status.INVALID_ARGUMENT,
              message: "userId and sessionId are required",
            });
            return;
          }

          const notification =
            await deps.notificationRepo.findByNewLoginSessionId(
              req.userId,
              req.sessionId
            );
          if (!notification) {
            callback(null, { notificationId: "", updated: false });
            return;
          }

          const updated = await deps.notificationRepo.recordAction(
            notification.id,
            req.userId,
            req.body ?? "",
            req.action ?? ""
          );

          if (updated) {
            const payloadObj = (updated.payload ?? {}) as {
              title?: string;
              body?: string;
            };
            try {
              await publishUserSocketEvent(
                redis,
                req.userId,
                "notification:updated",
                {
                  notificationId: updated.id,
                  userId: req.userId,
                  type: updated.type,
                  title: payloadObj.title ?? "",
                  // Login rows keep their "New login detected on …" body; the
                  // outcome the caller asked for rides in data.actionTaken.
                  body: payloadObj.body ?? "",
                  isRead: true,
                  createdAt: updated.createdAt.getTime(),
                  data: {
                    actionTaken: req.action ?? "",
                    sessionId: req.sessionId,
                  },
                }
              );
            } catch (err) {
              logger.warn(
                `recordSessionAction notify:updated publish failed for ${req.userId}: ${String(err)}`
              );
            }
          }

          callback(null, {
            notificationId: notification.id,
            updated: !!updated,
          });
        } catch (err) {
          logger.error(`gRPC recordSessionAction error: ${String(err)}`);
          callback({ code: grpc.status.INTERNAL, message: String(err) });
        }
      })();
    },
  };
}
