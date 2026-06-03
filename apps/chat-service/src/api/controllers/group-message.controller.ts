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
import type { GroupMessageService } from "../../services/group-message.service.js";
import type { GroupPinService } from "../../services/group-pin.service.js";

export class GroupMessageController {
  constructor(
    private readonly messageService: GroupMessageService,
    private readonly pinService: GroupPinService,
    private readonly redis: Redis | Cluster
  ) {}

  getMessages = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    // Timestamp pagination (epoch ms). before_ts → createdAt <= ts (newest-first);
    // after_ts → createdAt >= ts (oldest-first); neither → newest page.
    const beforeTs =
      req.query.before_ts != null ? Number(req.query.before_ts) : undefined;
    const afterTs =
      req.query.after_ts != null ? Number(req.query.after_ts) : undefined;
    const limit = Number(req.query.limit) || 30;
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
    const paginated = buildTimelineResponse(
      result.items as unknown as Record<string, unknown>[],
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
    const paginated = buildPaginatedResponse(
      messages as unknown as Record<string, unknown>[],
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
    const paginated = buildCursorResponse(
      messages as unknown as Record<string, unknown>[],
      limit,
      "createdAt"
    );
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
    if (result.roomId) {
      await this.redis.publish(
        `conv:${result.roomId}`,
        JSON.stringify({
          event: "message:edited",
          data: {
            messageId: result.id,
            conversationId: result.roomId,
            contentText:
              ((result.content as Record<string, unknown>)?.text as string) ??
              "",
            contentJson: ((): string => {
              try {
                return JSON.stringify(result.content ?? {});
              } catch {
                return "{}";
              }
            })(),
            editedAt:
              result.editedAt instanceof Date
                ? result.editedAt.getTime()
                : Date.now(),
          },
        })
      );
    }
    res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(result, t("CHAT_MESSAGE_EDITED", req.locale)));
  });

  deleteMessage = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const { messageId, roomId } = req.body;
    const result = await this.messageService.deleteMessage(
      messageId,
      userId,
      roomId
    );
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

  searchMessages = asyncHandler(async (req: Request, res: Response) => {
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
      this.messageService.searchMessages({ roomId, query, limit }),
      this.messageService.countSearchResults(roomId, query),
    ]);
    const paginated = buildListResponse(messages, totalCount, page, limit);
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
      targetRoomId,
      senderId: userId,
      senderName: senderName ?? "",
      senderAvatar: senderAvatar ?? "",
      clientMessageId: clientMessageId ?? null,
    });
    await this.redis.publish(
      `conv:${targetRoomId}`,
      JSON.stringify({
        event: "message:new",
        data: {
          messageId: result.id,
          conversationId: targetRoomId,
          senderId: userId,
          contentType: result.messageType,
          isForwarded: true,
        },
      })
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
}
