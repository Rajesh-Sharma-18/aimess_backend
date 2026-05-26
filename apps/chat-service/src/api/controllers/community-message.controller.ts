import type { Request, Response } from "express";
import type { Server } from "socket.io";

import { ApiResponse, asyncHandler } from "@aimess/utils";
import { HTTP_STATUS, t } from "@aimess/constants";

import {
  buildPaginatedResponse,
  buildListResponse,
} from "../../lib/pagination.js";
import { GENERAL_EMIT, GENERAL_PREFIX } from "../../types/socket-events.js";
import type { CommunityMessageService } from "../../services/community-message.service.js";

export class CommunityMessageController {
  constructor(private readonly service: CommunityMessageService) {}

  getMessages = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    const cursor = req.query.cursor as string | undefined;
    const limit = Number(req.query.limit) || 20;
    const page = Number(req.query.page) || 1;
    const [messages, totalCount] = await Promise.all([
      this.service.getMessages({ roomId, userId, cursor, limit }),
      this.service.countMessages(roomId),
    ]);
    const paginated = buildPaginatedResponse(
      messages as unknown as Record<string, unknown>[],
      totalCount,
      page,
      limit,
      "createdAt"
    );
    const msg = paginated.data.length
      ? t("CHAT_COMMUNITY_MESSAGES_FETCHED", req.locale)
      : t("CHAT_NO_COMMUNITY_MESSAGES_FOUND", req.locale);
    res.status(HTTP_STATUS.OK).json(new ApiResponse(paginated, msg));
  });

  deleteMessage = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const messageId = req.params.messageId as string;
    const type = req.query.type as string;

    const result =
      type === "forEveryone"
        ? await this.service.deleteForAll(messageId, userId)
        : await this.service.deleteForMe(messageId, userId);

    // Emit real-time deletion event to the community room.
    // Client rule: hide for everyone on "forEveryone"; hide only if deletedBy===myId on "forMe".
    const io = req.app.get("io") as Server | undefined;
    if (io && result?.roomId) {
      io.to(`${GENERAL_PREFIX}:${result.roomId}`).emit(
        GENERAL_EMIT.MESSAGE_DELETE_NEW(result.roomId),
        {
          messageId: result.id,
          type: type === "forEveryone" ? "forEveryone" : "forMe",
          deletedBy: userId,
        }
      );
    }

    res.status(HTTP_STATUS.OK).json(new ApiResponse(result));
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
}
