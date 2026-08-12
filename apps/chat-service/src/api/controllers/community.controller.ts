import type { Request, Response } from "express";

import { ApiResponse, asyncHandler } from "@aimess/utils";
import { HTTP_STATUS, t } from "@aimess/constants";

import { buildListResponse } from "../../lib/pagination.js";
import type { CommunityRoomService } from "../../services/community-room.service.js";

export class CommunityController {
  constructor(private readonly service: CommunityRoomService) {}

  getRooms = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const limit = Number(req.query.limit) || 20;
    const page = Number(req.query.page) || 1;
    const [rooms, totalCount] = await Promise.all([
      this.service.getRooms(userId, page, limit),
      this.service.countRooms(userId),
    ]);
    const paginated = buildListResponse(rooms, totalCount, page, limit);
    const msg = paginated.data.length
      ? t("CHAT_COMMUNITY_ROOMS_FETCHED", req.locale)
      : t("CHAT_NO_COMMUNITY_ROOMS_FOUND", req.locale);
    res.status(HTTP_STATUS.OK).json(new ApiResponse(paginated, msg));
  });

  searchRooms = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const { query } = req.query as { query: string };
    const limit = Number(req.query.limit) || 20;
    const page = Number(req.query.page) || 1;
    const [rooms, totalCount] = await Promise.all([
      this.service.searchRooms(query, userId, page, limit),
      this.service.countSearchResults(query, userId),
    ]);
    const paginated = buildListResponse(rooms, totalCount, page, limit);
    const msg = paginated.data.length
      ? t("CHAT_COMMUNITY_ROOMS_SEARCHED", req.locale)
      : t("CHAT_NO_COMMUNITY_ROOMS_FOUND", req.locale);
    res.status(HTTP_STATUS.OK).json(new ApiResponse(paginated, msg));
  });

  join = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    await this.service.join(roomId, userId);
    res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(null, t("CHAT_ROOM_JOINED", req.locale)));
  });

  leave = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    await this.service.leave(roomId, userId);
    res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(null, t("CHAT_ROOM_LEFT", req.locale)));
  });
}
