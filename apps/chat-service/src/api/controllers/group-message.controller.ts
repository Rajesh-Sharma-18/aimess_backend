import type { Request, Response } from "express";
import type { Redis, Cluster } from "ioredis";

import { ApiResponse, asyncHandler } from "@aimess/utils";
import { HTTP_STATUS, t } from "@aimess/constants";

import {
  buildPaginatedResponse,
  buildListResponse,
} from "../../lib/pagination.js";
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
    const cursor = req.query.cursor as string | undefined;
    const limit = Number(req.query.limit) || 30;
    const page = Number(req.query.page) || 1;
    const [messages, totalCount] = await Promise.all([
      this.messageService.getMessages({ roomId, userId, cursor, limit }),
      this.messageService.countMessages(roomId),
    ]);
    const paginated = buildPaginatedResponse(
      messages as unknown as Record<string, unknown>[],
      totalCount,
      page,
      limit,
      "createdAt"
    );
    const msg = paginated.data.length
      ? t("CHAT_MESSAGES_FETCHED", req.locale)
      : t("CHAT_NO_MESSAGES_FOUND", req.locale);
    res.status(HTTP_STATUS.OK).json(new ApiResponse(paginated, msg));
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
