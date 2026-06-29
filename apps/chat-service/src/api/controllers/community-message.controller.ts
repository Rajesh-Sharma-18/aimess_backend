import type { Request, Response } from "express";
import type { Redis, Cluster } from "ioredis";

import { logger } from "@aimess/logger";
import { BadRequestError, NotFoundError } from "@aimess/errors";
import { ApiResponse, asyncHandler } from "@aimess/utils";
import { HTTP_STATUS, t } from "@aimess/constants";

import {
  buildPaginatedResponse,
  buildListResponse,
  buildCursorResponse,
  buildTimelineResponse,
} from "../../lib/pagination.js";
import {
  normalizeMessageType,
  buildDeletePayload,
} from "../../lib/chat-message.serializer.js";
import { publishCommunityUpdatedSafe } from "../../events/publish-conv-updated.js";
import { publishCommunityActivitySafe } from "../../events/publish-community-activity.js";
import type { CommunityMessageService } from "../../services/community-message.service.js";
import type { CommunityPinService } from "../../services/community-pin.service.js";
import type { ChatMessageOrchestrator } from "../../services/chat-message-orchestrator.js";

export class CommunityMessageController {
  constructor(
    private readonly service: CommunityMessageService,
    private readonly pinService: CommunityPinService,
    private readonly redis: Redis | Cluster,
    private readonly orchestrator: ChatMessageOrchestrator
  ) {}

  /**
   * POST /community/rooms/:roomId/messages — send a community message. Delegates
   * to the ChatMessageOrchestrator (send + community:message:new broadcast +
   * community-activity + community:updated bump). Active-membership and
   * suspended-room guards + idempotency live in the service. roomId (chat
   * GeneralRoom id) comes from the path; communityId (used for the broadcast) is
   * in the body. Returns the canonical wire message; 201 on a fresh insert, 200
   * on an idempotent replay (`idempotent: true`) — matching the private/group
   * send contract.
   */
  sendMessage = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    const body = req.body as {
      communityId: string;
      communityName?: string;
      message: string;
      messageType: string;
      parentMessageId?: string | null;
      clientMessageId?: string | null;
      media?: { files: Array<Record<string, unknown>> };
      location?: Record<string, unknown>;
      contact?: Record<string, unknown>;
      sticker?: Record<string, unknown>;
    };

    // Flatten the structured body into the service attachments array, mirroring
    // the gRPC handler's priority: structured files > location > contact >
    // sticker. The orchestrator re-splits location/contact/sticker for the
    // broadcast shape via their `type` discriminator.
    let attachments: Array<Record<string, unknown>> | undefined;
    if (body.media?.files?.length) {
      attachments = body.media.files;
    } else if (body.location) {
      attachments = [{ type: "location", ...body.location }];
    } else if (body.contact) {
      attachments = [{ type: "contact", ...body.contact }];
    } else if (body.sticker) {
      attachments = [{ type: "sticker", ...body.sticker }];
    }

    const result = await this.orchestrator.sendCommunity({
      communityId: body.communityId,
      communityName: body.communityName,
      roomId,
      senderId: userId,
      message: body.message,
      messageType: body.messageType,
      parentMessageId: body.parentMessageId ?? null,
      clientMessageId: body.clientMessageId ?? null,
      attachments,
    });

    res
      .status(result.alreadySent ? HTTP_STATUS.OK : HTTP_STATUS.CREATED)
      .json(
        new ApiResponse(
          { ...result.message, idempotent: result.alreadySent },
          t("CHAT_MESSAGE_SENT", req.locale)
        )
      );
  });

  /**
   * POST /community/rooms/:roomId/read — mark this community room read.
   * Community read is COARSER than private/group: it advances the member's read
   * pointer to "now" (read-to-now) rather than to a specific message, and has NO
   * socket broadcast today — so this stays thin and calls bulkMarkRead directly
   * instead of routing through the orchestrator. The body's `upToMessageId` is
   * accepted (request parity) but not used for a per-message high-water mark.
   */
  markRead = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    await this.service.bulkMarkRead(userId, [roomId]);
    res.status(HTTP_STATUS.OK).json(new ApiResponse({ ok: true }));
  });

  getMessages = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    const limit = Number(req.query.limit) || 30;
    const around = req.query.around as string | undefined;

    if (around) {
      const { items, total } = await this.service.getMessagesAround({
        roomId,
        userId,
        messageId: around,
        limit,
      });
      const paginated = buildTimelineResponse(
        items as unknown as Record<string, unknown>[],
        total,
        limit,
        false,
        null
      );
      res
        .status(HTTP_STATUS.OK)
        .json(
          new ApiResponse(
            paginated,
            items.length
              ? t("CHAT_COMMUNITY_MESSAGES_FETCHED", req.locale)
              : t("CHAT_NO_COMMUNITY_MESSAGES_FOUND", req.locale)
          )
        );
      return;
    }

    // `before_ts` is the history-scroll cursor. It is EITHER a plain epoch-ms
    // (a first/manual call) OR the opaque COMPOUND cursor "<ms>_<objectId>"
    // handed back as `nextCursor` from a previous page. Splitting on "_" yields
    // the keyset (ts, id) — the id tiebreaker is what makes messages that share
    // a millisecond reachable instead of being skipped at a page boundary.
    const rawBeforeTs =
      req.query.before_ts != null ? String(req.query.before_ts) : undefined;
    let beforeTs: number | undefined;
    let beforeId: string | null = null;
    if (rawBeforeTs != null && rawBeforeTs !== "") {
      const sep = rawBeforeTs.indexOf("_");
      const msPart = sep === -1 ? rawBeforeTs : rawBeforeTs.slice(0, sep);
      const idPart = sep === -1 ? "" : rawBeforeTs.slice(sep + 1);
      beforeTs = Number(msPart);
      beforeId = idPart || null;
    }
    const afterTs =
      req.query.after_ts != null ? Number(req.query.after_ts) : undefined;

    // Incremental-sync mode: after_ts only.
    // Returns every message (new, edited, reacted, deleted tombstone) whose
    // updatedAt >= after_ts. Feed the returned nextCursor as the next after_ts.
    if (afterTs != null) {
      if (!Number.isFinite(afterTs) || afterTs < 0) {
        throw new BadRequestError("CHAT_INVALID_SINCE_TS");
      }
      const result = await this.service.getMessagesSince({
        roomId,
        userId,
        fromTs: new Date(afterTs),
        limit,
      });
      const msg = result.items.length
        ? t("CHAT_COMMUNITY_MESSAGES_FETCHED", req.locale)
        : t("CHAT_NO_COMMUNITY_MESSAGES_FOUND", req.locale);
      res.status(HTTP_STATUS.OK).json(
        new ApiResponse(
          {
            data: result.items,
            hasMore: result.hasMore,
            // Store this as the next after_ts to page forward or re-sync.
            nextCursor: result.nextCursor,
          },
          msg
        )
      );
      return;
    }

    // Scroll / history mode: before_ts → newest-first older page, omit → latest
    // page. (after_ts was handled above via incremental sync and returned.)
    const hasBefore = beforeTs != null;
    const result = await this.service.getMessagesTimeline({
      roomId,
      userId,
      direction: "before",
      ts: new Date(hasBefore ? beforeTs! : Date.now()),
      boundaryId: beforeId,
      // First page (no before_ts) includes the newest message; a bare-ms cursor
      // is treated as exclusive so it never re-returns its own boundary row.
      inclusive: !hasBefore,
      limit,
    });
    const paginated = buildTimelineResponse(
      result.items as unknown as Record<string, unknown>[],
      result.total,
      limit,
      result.hasMore,
      result.nextCursor
    );
    const msg = paginated.data.length
      ? t("CHAT_COMMUNITY_MESSAGES_FETCHED", req.locale)
      : t("CHAT_NO_COMMUNITY_MESSAGES_FOUND", req.locale);
    res.status(HTTP_STATUS.OK).json(new ApiResponse(paginated, msg));
  });

  getConversation = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    const pageNumber = Number(req.query.pageNumber) || 1;
    const limit = Number(req.query.limit) || 30;
    const timestamp = req.query.timestamp
      ? Number(req.query.timestamp)
      : undefined;
    const { messages, total } = await this.service.getConversation({
      roomId,
      userId,
      pageNumber,
      limit,
      timestamp,
    });
    const paginated = buildPaginatedResponse(
      messages as unknown as Record<string, unknown>[],
      total,
      pageNumber,
      limit,
      "createdAt"
    );
    const msg = paginated.data.length
      ? t("CHAT_COMMUNITY_MESSAGES_FETCHED", req.locale)
      : t("CHAT_NO_COMMUNITY_MESSAGES_FOUND", req.locale);
    res.status(HTTP_STATUS.OK).json(new ApiResponse(paginated, msg));
  });

  getRoomMedia = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    const type = req.query.type as string | undefined;
    const cursor = req.query.cursor as string | undefined;
    const limit = Number(req.query.limit) || 30;
    const messages = await this.service.listMedia({
      roomId,
      userId,
      type,
      cursor,
      limit,
    });
    const paginated = buildCursorResponse(
      messages as unknown as Record<string, unknown>[],
      limit,
      "createdAt"
    );
    const msg = paginated.items.length
      ? t("CHAT_COMMUNITY_MESSAGES_FETCHED", req.locale)
      : t("CHAT_NO_COMMUNITY_MESSAGES_FOUND", req.locale);
    res.status(HTTP_STATUS.OK).json(new ApiResponse(paginated, msg));
  });

  editMessage = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const messageId = req.params.messageId as string;
    const { content } = req.body as {
      communityId: string;
      content: { text: string };
    };
    const result = await this.service.editMessage({
      messageId,
      userId,
      content,
    });
    // Broadcast on the message's OWN room (GeneralRoom.id === communityId, so
    // result.roomId is the correct channel for all legitimate messages). Using
    // the body-supplied communityId here would let a member of community A fan
    // the event onto community B's channel (cross-channel info disclosure).
    // §1: community edit uses thin payload (not buildChatMessageEvent) until Phase 3.
    // REST body == socket payload so the client uses one shape for both.
    const editedPayload = {
      messageId: result.id,
      communityId: result.roomId,
      roomId: result.roomId,
      senderId: result.sentBy,
      message: result.message ?? "",
      contentType: normalizeMessageType(result.messageType),
      isEdited: true,
      editedAt:
        result.editedAt instanceof Date
          ? result.editedAt.getTime()
          : Date.now(),
    };
    await this.redis.publish(
      `community:${result.roomId}`,
      JSON.stringify({ event: "community:message:edited", data: editedPayload })
    );
    res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(editedPayload, t("CHAT_MESSAGE_EDITED", req.locale))
      );
  });

  reactToMessage = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const messageId = req.params.messageId as string;
    const { emoji } = req.body as {
      communityId: string;
      emoji: string;
    };

    const result = await this.service.reactToMessage({
      messageId,
      userId,
      emoji,
    });

    this.redis
      .publish(
        `community:${result.roomId}`,
        JSON.stringify({
          event: "community:message:reaction",
          data: {
            messageId: result.messageId,
            communityId: result.roomId,
            reactions: result.reactions,
          },
        })
      )
      .catch((err: unknown) => {
        logger.warn(
          `community:message:reaction publish failed: ${String(err)}`
        );
      });

    res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(result, t("CHAT_MESSAGE_EDITED", req.locale))); // TODO: add CHAT_MESSAGE_REACTED key to @aimess/constants
  });

  deleteMessage = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const messageId = req.params.messageId as string;
    const type = req.query.type as string;

    const result =
      type === "forEveryone"
        ? await this.service.deleteForAll(messageId, userId)
        : await this.service.deleteForMe(messageId, userId);

    if (!result) {
      throw new NotFoundError("CHAT_MESSAGE_NOT_FOUND");
    }

    // Emit real-time deletion event to the community room.
    const tombstone = buildDeletePayload({
      conversationType: "COMMUNITY",
      messageId: result.id,
      roomId: result.roomId,
      scope: type === "forEveryone" ? "forEveryone" : "forMe",
      deletedBy: userId,
    });
    if (result?.roomId) {
      await this.redis.publish(
        `community:${result.roomId}`,
        JSON.stringify({ event: "community:message:deleted", data: tombstone })
      );
    }

    // When deleted for everyone: recalculate and broadcast the new last-message
    // preview to all members so the community list never shows "Message deleted".
    if (type === "forEveryone" && result.roomId) {
      void this.service
        .recalculateLastMessageAfterDelete(result.roomId, messageId)
        .then((recalc) => {
          if (recalc === null) return; // not the last message — no-op
          publishCommunityUpdatedSafe({
            redis: this.redis,
            communityId: result.roomId,
            roomId: result.roomId,
            fetchMembers: () => this.service.getActiveMemberIds(result.roomId),
            senderId: recalc.sentBy,
            senderName: recalc.senderName,
            lastMessageId: recalc.prevMessageId ?? "",
            lastMessageAt: recalc.createdAt.getTime(),
            preview: {
              contentType: normalizeMessageType(recalc.messageType),
              text: recalc.preview,
            },
          });
          if (recalc.hasLastMessage) {
            publishCommunityActivitySafe({
              communityId: result.roomId,
              lastMessageAt: new Date().toISOString(),
              lastMessageId: recalc.prevMessageId ?? "",
              senderUserId: recalc.sentBy,
              senderUsername: recalc.senderName,
              messagePreview: recalc.preview,
              type: "message",
            });
          }
        })
        .catch((err: unknown) => {
          logger.warn(
            `deleteMessage|recalculate lastMessage failed roomId=${result.roomId}: ${String(err)}`
          );
        });
    }

    // When deleted for me: send a targeted community:updated ONLY to the
    // deleting user so their community list shows the previous message they
    // can see. The shared GeneralRoom snapshot and community-service
    // lastActivityPreview are NOT changed — all other members are unaffected.
    if (type !== "forEveryone" && result.roomId) {
      void this.service
        .recalculateLastMessageAfterDeleteForMe(
          result.roomId,
          result.createdAt,
          userId
        )
        .then((recalc) => {
          // Skip unless the deleted message was the viewer's effective last
          // visible message — hiding an older message changes nothing in their list.
          if (recalc === null || !recalc.wasEffectiveLast) return;
          publishCommunityUpdatedSafe({
            redis: this.redis,
            communityId: result.roomId,
            roomId: result.roomId,
            fetchMembers: () => Promise.resolve([userId]),
            senderId: recalc.sentBy,
            senderName: recalc.senderName,
            lastMessageId: recalc.prevMessageId ?? "",
            lastMessageAt: recalc.createdAt.getTime(),
            preview: {
              contentType: normalizeMessageType(recalc.messageType),
              text: recalc.preview,
            },
          });
        })
        .catch((err: unknown) => {
          logger.warn(
            `deleteMessage|recalculateForMe failed roomId=${result.roomId}: ${String(err)}`
          );
        });
    }

    // When deleted for everyone, check if the message was actively pinned.
    // If so: mark the pin unavailable and emit community:message:pinned update.
    if (type === "forEveryone" && result.roomId) {
      void this.pinService
        .handleMessageDeleted(messageId)
        .then((affectedPin) => {
          if (!affectedPin) return;
          return this.redis.publish(
            `community:${result.roomId}`,
            JSON.stringify({
              event: "community:message:pinned",
              data: {
                communityId: result.roomId,
                roomId: result.roomId,
                pin: {
                  ...affectedPin,
                  originalMessage: { isAvailable: false },
                },
                pinnedCount: null, // unchanged; client uses cached count
              },
            })
          );
        })
        .catch((err: unknown) => {
          logger.warn(
            `deleteMessage|pin hook failed messageId=${messageId}: ${String(err)}`
          );
        });
    }

    res.status(HTTP_STATUS.OK).json(new ApiResponse(tombstone));
  });

  /**
   * GET /rooms/:roomId/sync?since_ts=<ms>&limit=<n>
   *
   * Community incremental-sync REST endpoint. Returns all messages (new,
   * edited, reacted, deleted tombstones) whose `updatedAt >= since_ts`,
   * sorted oldest-first. Mirrors `GET /rooms/:roomId/messages?after_ts=` but
   * is rate-limited independently and uses a mandatory `since_ts` parameter so
   * the intent is unambiguous.
   *
   * Response shape: `{ data, hasMore, nextCursor }` — `nextCursor` is the
   * epoch-ms string of the last item's updatedAt; feed it back as `since_ts`.
   */
  syncMessages = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    const sinceTs = Number(req.query.since_ts);
    const limit = Number(req.query.limit) || 50;

    if (!Number.isFinite(sinceTs) || sinceTs < 0) {
      throw new BadRequestError("CHAT_INVALID_SINCE_TS");
    }

    const result = await this.service.getMessagesSince({
      roomId,
      userId,
      fromTs: new Date(sinceTs),
      limit,
    });

    const msg = result.items.length
      ? t("CHAT_COMMUNITY_MESSAGES_FETCHED", req.locale)
      : t("CHAT_NO_COMMUNITY_MESSAGES_FOUND", req.locale);

    res.status(HTTP_STATUS.OK).json(
      new ApiResponse(
        {
          data: result.items,
          hasMore: result.hasMore,
          nextCursor: result.nextCursor,
        },
        msg
      )
    );
  });

  searchMessages = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    const query = ((req.query.q as string) ?? "").trim();
    const limit = Number(req.query.limit) || 30;
    const page = Number(req.query.page) || 1;
    if (!query) {
      const empty = buildListResponse([], 0, page, limit);
      res
        .status(HTTP_STATUS.OK)
        .json(
          new ApiResponse(
            empty,
            t("CHAT_NO_COMMUNITY_MESSAGES_FOUND", req.locale)
          )
        );
      return;
    }
    const [messages, totalCount] = await Promise.all([
      this.service.searchMessages({ roomId, userId, query, limit }),
      this.service.countSearchResults(roomId, query),
    ]);
    const paginated = buildListResponse(messages, totalCount, page, limit);
    const msg = paginated.data.length
      ? t("CHAT_COMMUNITY_MESSAGES_FETCHED", req.locale)
      : t("CHAT_NO_COMMUNITY_MESSAGES_FOUND", req.locale);
    res.status(HTTP_STATUS.OK).json(new ApiResponse(paginated, msg));
  });

  pinMessage = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    const { messageId, communityId } = req.body as {
      messageId: string;
      communityId: string;
    };
    const result = await this.pinService.pin({
      roomId,
      messageId,
      userId,
      communityId,
    });
    await this.redis.publish(
      `community:${communityId}`,
      JSON.stringify({
        event: "community:message:pinned",
        data: {
          roomId,
          communityId,
          pin: result.pin,
          pinnedCount: result.pinnedCount,
        },
      })
    );
    res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(result, t("CHAT_MESSAGE_PINNED", req.locale)));
  });

  unpinMessage = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    const messageId = req.params.messageId as string;
    const communityId = req.query.communityId as string;
    const result = await this.pinService.unpin({ roomId, messageId, userId });
    await this.redis.publish(
      `community:${communityId}`,
      JSON.stringify({
        event: "community:message:unpinned",
        data: {
          roomId,
          communityId,
          messageId,
          pin: result.pin,
          pinnedCount: result.pinnedCount,
        },
      })
    );
    res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(result, t("CHAT_MESSAGE_UNPINNED", req.locale)));
  });

  getPins = asyncHandler(async (req: Request, res: Response) => {
    const roomId = req.params.roomId as string;
    // cursor = "<ms>_<id>" compound format (ISO datetime accepted for backward compat)
    const cursor = req.query.cursor as string | undefined;
    const limit = Number(req.query.limit) || 20;
    const pins = await this.pinService.list(roomId, { limit, cursor });
    const hasMore = pins.length === limit;
    const nextCursor =
      hasMore && pins.length > 0
        ? `${(pins[pins.length - 1]!.pinnedAt as Date).getTime()}_${pins[pins.length - 1]!.id}`
        : null;
    res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(
          { data: pins, hasMore, nextCursor },
          t("CHAT_PINS_FETCHED", req.locale)
        )
      );
  });

  /**
   * GET /rooms/:roomId/messages/:messageId/context
   *
   * Returns navigation anchor for a message (e.g. from pin banner tap).
   * FE uses the returned cursor to call GET /rooms/:roomId/messages?around=<messageId>.
   *
   * Response:
   *   200 { messageId, roomId, isAvailable: true, anchor: { beforeCursor, afterCursor } }
   *   200 { messageId, roomId, isAvailable: false, error: { code, message } }
   */
  getMessageContext = asyncHandler(async (req: Request, res: Response) => {
    const roomId = req.params.roomId as string;
    const messageId = req.params.messageId as string;
    const { userId } = req.auth;

    // Require community membership to navigate to a message
    await this.service.assertMember(roomId, userId);

    const message = await this.service.findMessageById(messageId, roomId);
    if (!message || message.roomId !== roomId) {
      // Message doesn't exist at all
      res.status(HTTP_STATUS.OK).json(
        new ApiResponse({
          messageId,
          roomId,
          isAvailable: false,
          error: {
            code: "MESSAGE_NOT_FOUND",
            message: "Message doesn't exist",
          },
        })
      );
      return;
    }

    if (message.deletedForAll) {
      res.status(HTTP_STATUS.OK).json(
        new ApiResponse({
          messageId,
          roomId,
          isAvailable: false,
          error: {
            code: "MESSAGE_NOT_FOUND",
            message: "Message doesn't exist",
          },
        })
      );
      return;
    }

    // Build compound cursor anchor so the FE can call ?around=<messageId>
    const ms =
      message.createdAt instanceof Date
        ? message.createdAt.getTime()
        : Number(message.createdAt);
    const beforeCursor = `${ms}_${messageId}`;
    const afterCursor = `${ms}_${messageId}`;

    res.status(HTTP_STATUS.OK).json(
      new ApiResponse({
        messageId,
        roomId,
        isAvailable: true,
        anchor: { beforeCursor, afterCursor },
      })
    );
  });
}
