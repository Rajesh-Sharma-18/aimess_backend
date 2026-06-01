import type { Request, Response } from "express";
import type { Redis, Cluster } from "ioredis";

import { ApiResponse, asyncHandler } from "@aimess/utils";
import { HTTP_STATUS, t } from "@aimess/constants";

import {
  buildPaginatedResponse,
  buildListResponse,
  buildCursorResponse,
} from "../../lib/pagination.js";
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
    const cursor = req.query.cursor as string | undefined;
    const limit = Number(req.query.limit) || 30;
    const page = Number(req.query.page) || 1;
    const [messages, totalCount] = await Promise.all([
      this.messageService.getMessages({ roomId, userId, cursor, limit }),
      this.messageService.countMessages(roomId),
    ]);
    const enriched = await this.messageService.enrichMessages(messages);
    const paginated = buildPaginatedResponse(
      enriched,
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
          data: {
            messageId: result.id,
            type: type === "forEveryone" ? "forEveryone" : "forMe",
            deletedBy: userId,
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
