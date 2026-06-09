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
import {
  buildChatMessageEvent,
  groupStoredReactions,
} from "../../lib/chat-message.serializer.js";
import type { PrivateMessageService } from "../../services/private-message.service.js";
import type { PrivatePinService } from "../../services/private-pin.service.js";

export class PrivateMessageController {
  constructor(
    private readonly messageService: PrivateMessageService,
    private readonly pinService: PrivatePinService,
    private readonly redis: Redis | Cluster
  ) {}

  getMessages = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    const limit = Number(req.query.limit) || 30;

    // V2 §3.2: prefer seq-based keyset cursors (gap-safe) when present.
    // before_seq → sequenceNumber < seq (newest-first);
    // after_seq  → sequenceNumber > seq (oldest-first);
    // around=<messageId> → window centered on a message (jump-to-message).
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
      const enriched = await this.messageService.enrichMessages(items);
      const totalCount = await this.messageService.countMessages(roomId);
      const paginated = buildTimelineResponse(
        enriched,
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
            enriched.length
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
      const enriched = await this.messageService.enrichMessages(result.items);
      const paginated = buildTimelineResponse(
        enriched,
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

    // Timestamp pagination (epoch ms) — V1 fallback. before_ts → createdAt <= ts
    // (newest-first); after_ts → createdAt >= ts (oldest-first); neither → newest.
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
    const enriched = await this.messageService.enrichMessages(result.items);
    const paginated = buildTimelineResponse(
      enriched,
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
    const enriched = await this.messageService.enrichMessages(messages);
    const paginated = buildCursorResponse(enriched, limit, "createdAt");
    const msg = paginated.items.length
      ? t("CHAT_MESSAGES_FETCHED", req.locale)
      : t("CHAT_NO_MESSAGES_FOUND", req.locale);
    res.status(HTTP_STATUS.OK).json(new ApiResponse(paginated, msg));
  });

  deleteMessage = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const messageId = req.params.messageId as string;
    const type = req.query.type as string;

    const result =
      type === "forEveryone"
        ? await this.messageService.deleteForEveryone(messageId, userId)
        : await this.messageService.deleteForMe(messageId, userId);

    // Emit real-time deletion event so all participants update immediately.
    // Client rule: hide for everyone on "forEveryone"; hide only if deletedBy===myId on "forMe".
    if (result.roomId) {
      await this.redis.publish(
        `conv:${result.roomId}`,
        JSON.stringify({
          event: "message:delete",
          // §2.3: self-describing tombstone — conversationId + sequenceNumber so a
          // client can route/locate the delete even if the room isn't loaded.
          data: {
            messageId: result.id,
            conversationId: result.roomId,
            type: type === "forEveryone" ? "forEveryone" : "forMe",
            deletedBy: userId,
            sequenceNumber: result.sequenceNumber,
          },
        })
      );
    }

    res.status(HTTP_STATUS.OK).json(new ApiResponse(result));
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

  // V2 §2.5: pin a message and broadcast pin:updated so the pinned banner
  // updates live for everyone in the room (multi-device consistent).
  pin = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    const messageId = req.params.messageId as string;
    const result = await this.pinService.pin({ roomId, messageId, userId });
    const pinnedAt =
      result.pin.pinnedAt instanceof Date
        ? result.pin.pinnedAt.getTime()
        : Date.now();
    // Published to conv:<roomId> (where clients are joined) so it rides the
    // gateway's existing conv:* subscription, exactly like message:delete.
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
    const enriched = await this.messageService.enrichMessages(messages);
    const paginated = buildListResponse(enriched, totalCount, page, limit);
    const msg = paginated.data.length
      ? t("CHAT_MESSAGES_SEARCHED", req.locale)
      : t("CHAT_NO_MESSAGES_FOUND", req.locale);
    res.status(HTTP_STATUS.OK).json(new ApiResponse(paginated, msg));
  });

  forwardMessage = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const messageId = req.params.messageId as string;
    const { targetRoomId, receiverId, clientMessageId } = req.body as {
      targetRoomId: string;
      receiverId: string;
      clientMessageId?: string | null;
    };
    const result = await this.messageService.forwardMessage({
      sourceMessageId: messageId,
      targetRoomId,
      senderId: userId,
      receiverId,
      clientMessageId: clientMessageId ?? null,
    });
    {
      // §1/§9: REST forward previously emitted a thin 5-field message:new;
      // emit the canonical ChatMessage shape so it matches the socket forward.
      const full = result as unknown as Record<string, unknown>;
      await this.redis.publish(
        `conv:${targetRoomId}`,
        JSON.stringify({
          event: "message:new",
          data: buildChatMessageEvent({
            id: result.id,
            clientMessageId: (full.clientMessageId as string) ?? "",
            roomId: targetRoomId,
            conversationType: "PRIVATE",
            senderId: userId,
            receiverId,
            messageType: result.messageType,
            content: result.content ?? null,
            reactions: [],
            isForwarded: true,
            serverTs: result.createdAt?.getTime() ?? Date.now(),
            sequenceNumber: (full.sequenceNumber as number) ?? 0,
          }),
        })
      );
    }
    // Fire-and-forget bump — must never delay the HTTP response.
    publishConvUpdatedSafe({
      redis: this.redis,
      type: "PRIVATE",
      roomId: targetRoomId,
      recipientIds: [userId, receiverId],
      senderId: userId,
      lastMessageId: result.id,
      lastMessageAt: result.createdAt?.getTime() ?? Date.now(),
      preview: { contentType: result.messageType, text: "" },
    });
    res
      .status(HTTP_STATUS.CREATED)
      .json(new ApiResponse(result, t("CHAT_MESSAGE_FORWARDED", req.locale)));
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

  editMessage = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const messageId = req.params.messageId as string;
    const { content } = req.body as {
      content: {
        text: string;
        urls?: string[];
        files?: Array<Record<string, unknown>>;
      };
    };
    const result = await this.messageService.editMessage({
      messageId,
      userId,
      content,
    });
    if (result.roomId) {
      // §9: emit the FULL canonical ChatMessage shape on message:edited.
      const full = result as unknown as Record<string, unknown>;
      await this.redis.publish(
        `conv:${result.roomId}`,
        JSON.stringify({
          event: "message:edited",
          data: buildChatMessageEvent({
            id: result.id,
            clientMessageId: (full.clientMessageId as string) ?? "",
            roomId: result.roomId,
            conversationType: "PRIVATE",
            senderId: (full.senderId as string) ?? "",
            receiverId: (full.receiverId as string) ?? "",
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
          }),
        })
      );
    }
    res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(result, t("CHAT_MESSAGE_EDITED", req.locale)));
  });

  reportMessage = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const messageId = req.params.messageId as string;
    const { reason, description } = req.body as {
      reason: string;
      description?: string;
    };
    const result = await this.messageService.reportMessage({
      messageId,
      reporterId: userId,
      reason,
      description,
    });
    res
      .status(HTTP_STATUS.CREATED)
      .json(new ApiResponse(result, t("CHAT_MESSAGE_REPORTED", req.locale)));
  });
}
