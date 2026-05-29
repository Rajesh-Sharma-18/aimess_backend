import type { Request, Response } from "express";

import { ApiResponse, asyncHandler } from "@aimess/utils";
import { HTTP_STATUS, t } from "@aimess/constants";

import { buildPaginatedResponse } from "../../lib/pagination.js";
import type { PrivateRoomService } from "../../services/private-room.service.js";

export class PrivateRoomController {
  constructor(private readonly service: PrivateRoomService) {}

  getOrCreateRoom = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const peerId = req.params.peerId as string;
    const room = await this.service.getOrCreateRoom(userId, peerId);
    res.status(HTTP_STATUS.OK).json(new ApiResponse(room));
  });

  getConversationList = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const cursor = req.query.cursor as string | undefined;
    const limit = Number(req.query.limit) || 20;
    const page = Number(req.query.page) || 1;
    const [rooms, totalCount] = await Promise.all([
      this.service.getConversationList({ userId, limit, cursor }),
      this.service.countConversations(userId),
    ]);
    const paginated = buildPaginatedResponse(
      rooms as unknown as Record<string, unknown>[],
      totalCount,
      page,
      limit,
      "lastMessageAt"
    );
    const msg = paginated.data.length
      ? t("CHAT_CONVERSATIONS_FETCHED", req.locale)
      : t("CHAT_NO_CONVERSATIONS_FOUND", req.locale);
    res.status(HTTP_STATUS.OK).json(new ApiResponse(paginated, msg));
  });

  deleteForMe = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    await this.service.deleteForMe(roomId, userId);
    res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(null, t("CHAT_CONVERSATION_DELETED", req.locale)));
  });

  muteRoom = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    const { muteUntil } = req.body as { muteUntil?: string | null };
    const result = await this.service.muteRoom(
      roomId,
      userId,
      muteUntil ? new Date(muteUntil) : null
    );
    res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(result, t("CHAT_ROOM_MUTED", req.locale)));
  });

  unmuteRoom = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    const result = await this.service.unmuteRoom(roomId, userId);
    res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(result, t("CHAT_ROOM_UNMUTED", req.locale)));
  });
}
