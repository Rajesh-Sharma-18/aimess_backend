import type { Request, Response } from "express";
import type { Redis, Cluster } from "ioredis";

import { ApiResponse, asyncHandler } from "@aimess/utils";
import { HTTP_STATUS, t } from "@aimess/constants";

import {
  buildPaginatedResponse,
  buildListResponse,
  buildCursorResponse,
  buildTimelineResponse,
} from "../../lib/pagination.js";
import { publishConvUpdatedSafe } from "../../events/publish-conv-updated.js";
import { buildMessagePreview } from "../../events/publish-message-sent.js";
import {
  buildChatMessageEvent,
  buildDeletePayload,
  groupStoredReactions,
} from "../../lib/chat-message.serializer.js";
import type { GroupMessageService } from "../../services/group-message.service.js";
import type { GroupPinService } from "../../services/group-pin.service.js";
import type { ChatMessageOrchestrator } from "../../services/chat-message-orchestrator.js";

export class GroupMessageController {
  constructor(
    private readonly messageService: GroupMessageService,
    private readonly pinService: GroupPinService,
    private readonly redis: Redis | Cluster,
    private readonly orchestrator: ChatMessageOrchestrator
  ) {}

  /**
   * POST /groups/:roomId/messages — send a group message. Delegates to the
   * ChatMessageOrchestrator (send + message:new broadcast + conv:updated bump +
   * FCM push fan-out to active members). Active-membership and idempotency live
   * in the service. Returns the canonical wire message; 201 on a fresh insert,
   * 200 on an idempotent replay (`idempotent: true`).
   */
  sendMessage = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    const body = req.body as {
      content: {
        text: string;
        urls?: string[];
        files?: Array<Record<string, unknown>>;
        location?: Record<string, unknown>;
        contact?: Record<string, unknown>;
        sticker?: Record<string, unknown>;
      };
      messageType: string;
      parentMessageId?: string | null;
      clientMessageId?: string | null;
      clientTs?: number | null;
    };

    const result = await this.orchestrator.sendDirect({
      conversationType: "GROUP",
      roomId,
      senderId: userId,
      content: body.content,
      messageType: body.messageType,
      parentMessageId: body.parentMessageId ?? null,
      clientMessageId: body.clientMessageId ?? null,
      clientTs: body.clientTs ?? null,
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
   * POST /groups/:roomId/read — mark this group read up to `upToMessageId`.
   * Delegates to the ChatMessageOrchestrator (advance the group-member read
   * pointer + message:read receipt + read_sync to the reader's other devices),
   * mirroring the gRPC markMessagesRead effects. Returns { ok, readToSeq }.
   */
  markRead = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    const { upToMessageId } = req.body as { upToMessageId: string };

    const { readToSeq } = await this.orchestrator.markReadDirect({
      conversationType: "GROUP",
      roomId,
      readerId: userId,
      upToMessageId,
    });

    res.status(HTTP_STATUS.OK).json(new ApiResponse({ ok: true, readToSeq }));
  });

  getMessages = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    const limit = Number(req.query.limit) || 30;

    // V2 §3.2: prefer seq-based keyset cursors (gap-safe) when present.
    const beforeSeq =
      req.query.before_seq != null ? Number(req.query.before_seq) : undefined;
    const afterSeq =
      req.query.after_seq != null ? Number(req.query.after_seq) : undefined;
    const around = req.query.around as string | undefined;

    if (around) {
      const { items } = await this.messageService.getMessagesAround({
        roomId,
        userId,
        messageId: around,
        limit,
      });
      const [wire, totalCount] = await Promise.all([
        this.messageService.enrichForWire(items, userId),
        this.messageService.countMessages(roomId),
      ]);
      const paginated = buildTimelineResponse(
        wire,
        totalCount,
        limit,
        false,
        null
      );
      res
        .status(HTTP_STATUS.OK)
        .json(
          new ApiResponse(
            paginated,
            paginated.data.length
              ? t("CHAT_MESSAGES_FETCHED", req.locale)
              : t("CHAT_NO_MESSAGES_FOUND", req.locale)
          )
        );
      return;
    }

    if (beforeSeq != null || afterSeq != null) {
      const direction = afterSeq != null ? "after" : "before";
      const seq = afterSeq != null ? afterSeq : (beforeSeq as number);
      const [result, totalCount] = await Promise.all([
        this.messageService.getMessagesSeq({
          roomId,
          userId,
          direction,
          seq,
          limit,
        }),
        this.messageService.countMessages(roomId),
      ]);
      const wire = await this.messageService.enrichForWire(
        result.items,
        userId
      );
      const paginated = buildTimelineResponse(
        wire,
        totalCount,
        limit,
        result.hasMore,
        result.nextCursor
      );
      res
        .status(HTTP_STATUS.OK)
        .json(
          new ApiResponse(
            paginated,
            paginated.data.length
              ? t("CHAT_MESSAGES_FETCHED", req.locale)
              : t("CHAT_NO_MESSAGES_FOUND", req.locale)
          )
        );
      return;
    }

    // Timestamp pagination (epoch ms) — V1 fallback.
    const beforeTs =
      req.query.before_ts != null ? Number(req.query.before_ts) : undefined;
    const afterTs =
      req.query.after_ts != null ? Number(req.query.after_ts) : undefined;
    const direction = afterTs != null ? "after" : "before";
    const tsMs =
      afterTs != null ? afterTs : beforeTs != null ? beforeTs : Date.now();

    const [result, totalCount] = await Promise.all([
      this.messageService.getMessagesTimeline({
        roomId,
        userId,
        direction,
        ts: new Date(tsMs),
        limit,
      }),
      this.messageService.countMessages(roomId),
    ]);
    const wire = await this.messageService.enrichForWire(result.items, userId);
    const paginated = buildTimelineResponse(
      wire,
      totalCount,
      limit,
      result.hasMore,
      result.nextCursor
    );
    const msg = paginated.data.length
      ? t("CHAT_MESSAGES_FETCHED", req.locale)
      : t("CHAT_NO_MESSAGES_FOUND", req.locale);
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
    const { messages, total } = await this.messageService.getConversation({
      roomId,
      userId,
      pageNumber,
      limit,
      timestamp,
    });
    const wire = await this.messageService.enrichForWire(messages, userId);
    const paginated = buildPaginatedResponse(
      wire,
      total,
      pageNumber,
      limit,
      "createdAt"
    );
    const msg = paginated.data.length
      ? t("CHAT_MESSAGES_FETCHED", req.locale)
      : t("CHAT_NO_MESSAGES_FOUND", req.locale);
    res.status(HTTP_STATUS.OK).json(new ApiResponse(paginated, msg));
  });

  getRoomMedia = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    const type = req.query.type as string | undefined;
    const cursor = req.query.cursor as string | undefined;
    const limit = Number(req.query.limit) || 30;
    const messages = await this.messageService.listMedia({
      roomId,
      userId,
      type,
      cursor,
      limit,
    });
    const wire = await this.messageService.enrichForWire(messages, userId);
    const paginated = buildCursorResponse(wire, limit, "createdAt");
    const msg = paginated.items.length
      ? t("CHAT_MESSAGES_FETCHED", req.locale)
      : t("CHAT_NO_MESSAGES_FOUND", req.locale);
    res.status(HTTP_STATUS.OK).json(new ApiResponse(paginated, msg));
  });

  editMessage = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const messageId = req.params.messageId as string;
    const { content } = req.body as {
      content: { text: string; urls?: string[]; files?: unknown[] };
    };
    const result = await this.messageService.editMessage({
      messageId,
      userId,
      content,
    });
    // §9: build canonical ChatMessage ONCE — REST body == socket payload.
    // Groups denormalize senderName/senderAvatar on the row.
    const full = result as unknown as Record<string, unknown>;
    const editedEvent = buildChatMessageEvent({
      id: result.id,
      clientMessageId: (full.clientMessageId as string) ?? "",
      roomId: result.roomId,
      conversationType: "GROUP",
      senderId: (full.senderId as string) ?? "",
      senderName: (full.senderName as string) ?? "",
      senderAvatar: (full.senderAvatar as string) ?? "",
      messageType: (full.messageType as string) ?? "TEXT",
      content: result.content ?? null,
      parentMessageId: (full.parentMessageId as string) || "",
      quoteData: full.quoteData ?? null,
      reactions: groupStoredReactions(full.reactions),
      isDeleted: Boolean(full.isDeleted),
      editedAt:
        result.editedAt instanceof Date
          ? result.editedAt.getTime()
          : Date.now(),
      clientTs: Number(
        (full.clientInfo as Record<string, unknown> | null)?.clientTs ?? 0
      ),
      serverTs:
        result.createdAt instanceof Date
          ? result.createdAt.getTime()
          : Date.now(),
      sequenceNumber: (full.sequenceNumber as number) ?? 0,
    });
    if (result.roomId) {
      await this.redis.publish(
        `conv:${result.roomId}`,
        JSON.stringify({ event: "message:edited", data: editedEvent })
      );
    }
    res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(editedEvent, t("CHAT_MESSAGE_EDITED", req.locale)));
  });

  deleteMessage = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const { messageId, roomId } = req.body;
    const result = await this.messageService.deleteMessage(
      messageId,
      userId,
      roomId
    );
    // §2.3: canonical tombstone — REST body == socket payload byte-for-byte.
    const tombstone = result
      ? buildDeletePayload({
          conversationType: "GROUP",
          messageId: result.id,
          roomId: result.roomId,
          scope: "forEveryone",
          deletedBy: userId,
          sequenceNumber: result.sequenceNumber,
          deletedType:
            (result as { deletedType?: string }).deletedType ?? "SELF_DELETE",
        })
      : null;
    if (result?.roomId && tombstone) {
      await this.redis.publish(
        `conv:${result.roomId}`,
        JSON.stringify({ event: "message:delete", data: tombstone })
      );
    }
    res.status(HTTP_STATUS.OK).json(new ApiResponse(tombstone));
  });

  getPins = asyncHandler(async (req: Request, res: Response) => {
    const roomId = req.params.roomId as string;
    const cursor = req.query.cursor as string | undefined;
    const limit = Number(req.query.limit) || 20;
    const page = Number(req.query.page) || 1;
    const [pins, totalCount] = await Promise.all([
      this.pinService.list(roomId, { limit, cursor }),
      this.pinService.countPins(roomId),
    ]);
    const paginated = buildPaginatedResponse(
      pins as unknown as Record<string, unknown>[],
      totalCount,
      page,
      limit,
      "pinnedAt"
    );
    const msg = paginated.data.length
      ? t("CHAT_PINS_FETCHED", req.locale)
      : t("CHAT_NO_PINS_FOUND", req.locale);
    res.status(HTTP_STATUS.OK).json(new ApiResponse(paginated, msg));
  });

  // V2 §2.5: pin a group message and broadcast pin:updated to conv:<roomId>.
  pin = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    const messageId = req.params.messageId as string;
    const result = await this.pinService.pin({ roomId, messageId, userId });
    const pinnedAt =
      result.pin.pinnedAt instanceof Date
        ? result.pin.pinnedAt.getTime()
        : Date.now();
    await this.redis.publish(
      `conv:${roomId}`,
      JSON.stringify({
        event: "pin:updated",
        data: {
          roomId,
          conversationId: roomId,
          messageId,
          pinnedBy: userId,
          pinnedAt,
          action: "pinned",
          pinnedCount: result.pinnedCount,
        },
      })
    );
    res
      .status(HTTP_STATUS.CREATED)
      .json(new ApiResponse(result, "Message pinned"));
  });

  unpin = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    const messageId = req.params.messageId as string;
    const result = await this.pinService.unpin({ roomId, messageId, userId });
    await this.redis.publish(
      `conv:${roomId}`,
      JSON.stringify({
        event: "pin:updated",
        data: {
          roomId,
          conversationId: roomId,
          messageId,
          unpinnedBy: userId,
          action: "unpinned",
          pinnedCount: result.pinnedCount,
        },
      })
    );
    res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(result, "Message unpinned"));
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
        .json(new ApiResponse(empty, t("CHAT_NO_MESSAGES_FOUND", req.locale)));
      return;
    }
    const [messages, totalCount] = await Promise.all([
      this.messageService.searchMessages({ roomId, userId, query, limit }),
      this.messageService.countSearchResults(roomId, query),
    ]);
    const wire = await this.messageService.enrichForWire(messages, userId);
    const paginated = buildListResponse(wire, totalCount, page, limit);
    const msg = paginated.data.length
      ? t("CHAT_MESSAGES_SEARCHED", req.locale)
      : t("CHAT_NO_MESSAGES_FOUND", req.locale);
    res.status(HTTP_STATUS.OK).json(new ApiResponse(paginated, msg));
  });

  forwardMessage = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const messageId = req.params.messageId as string;
    const { targetRoomId, clientMessageId, senderName, senderAvatar } =
      req.body as {
        targetRoomId: string;
        clientMessageId?: string | null;
        senderName?: string;
        senderAvatar?: string;
      };
    const result = await this.messageService.forwardMessage({
      sourceMessageId: messageId,
      // :roomId path param is the SOURCE room — bind the source message to it so
      // a caller can't forward (and thereby read) a message from a group they're not in.
      sourceRoomId: req.params.roomId as string,
      targetRoomId,
      senderId: userId,
      senderName: senderName ?? "",
      senderAvatar: senderAvatar ?? "",
      clientMessageId: clientMessageId ?? null,
    });
    // §1/§9: build canonical ChatMessage ONCE — REST body == socket payload.
    const full = result as unknown as Record<string, unknown>;
    const forwardedEvent = buildChatMessageEvent({
      id: result.id,
      clientMessageId: (full.clientMessageId as string) ?? "",
      roomId: targetRoomId,
      conversationType: "GROUP",
      senderId: userId,
      senderName: senderName ?? (full.senderName as string) ?? "",
      senderAvatar: senderAvatar ?? (full.senderAvatar as string) ?? "",
      senderRole: (full.senderRole as string) ?? "",
      messageType: result.messageType,
      content: result.content ?? null,
      reactions: [],
      isForwarded: true,
      serverTs: result.createdAt?.getTime() ?? Date.now(),
      sequenceNumber: (full.sequenceNumber as number) ?? 0,
    });
    await this.redis.publish(
      `conv:${targetRoomId}`,
      JSON.stringify({ event: "message:new", data: forwardedEvent })
    );
    // Fire-and-forget bump (incl. member fetch) — must never delay the HTTP response.
    publishConvUpdatedSafe({
      redis: this.redis,
      type: "GROUP",
      roomId: targetRoomId,
      fetchRecipients: () =>
        this.messageService.getActiveMemberIds(targetRoomId),
      senderId: userId,
      lastMessageId: result.id,
      lastMessageAt: result.createdAt?.getTime() ?? Date.now(),
      preview: {
        contentType: result.messageType,
        text: buildMessagePreview(result.messageType, result.content),
      },
    });
    res
      .status(HTTP_STATUS.CREATED)
      .json(
        new ApiResponse(forwardedEvent, t("CHAT_MESSAGE_FORWARDED", req.locale))
      );
  });

  getMessageReactions = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const messageId = req.params.messageId as string;
    const roomId = req.params.roomId as string;
    const result = await this.messageService.getMessageReactions({
      messageId,
      roomId,
      requesterId: userId,
    });
    res.status(HTTP_STATUS.OK).json(new ApiResponse(result));
  });

  /**
   * POST /groups/:roomId/messages/:messageId/reactions — add the caller's `emoji`
   * reaction. Delegates to the orchestrator (active-member guard + idempotent
   * toggle-ON + message:reaction broadcast). Returns the updated ChatReactionGroup[]
   * under `{ reactions }`. Idempotent: re-adding an existing reaction is a no-op.
   */
  addReaction = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    const messageId = req.params.messageId as string;
    const { emoji } = req.body as { emoji: string };
    const { reactions } = await this.orchestrator.reactDirect({
      conversationType: "GROUP",
      roomId,
      messageId,
      userId,
      emoji,
      op: "add",
    });
    res.status(HTTP_STATUS.OK).json(new ApiResponse({ reactions }));
  });

  /**
   * DELETE /groups/:roomId/messages/:messageId/reactions/:emoji — remove the
   * caller's `emoji` reaction. Delegates to the orchestrator (active-member guard +
   * idempotent toggle-OFF + message:reaction broadcast). Returns the updated
   * ChatReactionGroup[]. Idempotent: removing an absent reaction is a no-op.
   */
  removeReaction = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    const messageId = req.params.messageId as string;
    const emoji = req.params.emoji as string;
    const { reactions } = await this.orchestrator.reactDirect({
      conversationType: "GROUP",
      roomId,
      messageId,
      userId,
      emoji,
      op: "remove",
    });
    res.status(HTTP_STATUS.OK).json(new ApiResponse({ reactions }));
  });
}
