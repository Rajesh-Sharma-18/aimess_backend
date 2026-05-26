import type { Request, Response } from "express";
import type { Server } from "socket.io";

import { ApiResponse, asyncHandler } from "@aimess/utils";
import { HTTP_STATUS, t } from "@aimess/constants";

import {
  buildPaginatedResponse,
  buildListResponse,
} from "../../lib/pagination.js";
import { PRIVATE_EMIT, PRIVATE_PREFIX } from "../../types/socket-events.js";
import type { PrivateMessageService } from "../../services/private-message.service.js";
import type { PrivatePinService } from "../../services/private-pin.service.js";

export class PrivateMessageController {
  constructor(
    private readonly messageService: PrivateMessageService,
    private readonly pinService: PrivatePinService
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
    const io = req.app.get("io") as Server | undefined;
    if (io && result.roomId) {
      io.to(`${PRIVATE_PREFIX}:${result.roomId}`).emit(
        PRIVATE_EMIT.MESSAGE_DELETE_NEW(result.roomId),
        {
          messageId: result.id,
          type: type === "forEveryone" ? "forEveryone" : "forMe",
          deletedBy: userId,
        }
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
}
