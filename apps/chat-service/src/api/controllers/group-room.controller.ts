import type { Request, Response } from "express";

import { ApiResponse, asyncHandler } from "@aimess/utils";
import { HTTP_STATUS, t } from "@aimess/constants";

import { buildPaginatedResponse } from "../../lib/pagination.js";
import type { GroupRoomService } from "../../services/group-room.service.js";

export class GroupRoomController {
  constructor(private readonly service: GroupRoomService) {}

  create = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const result = await this.service.createGroup({
      ...req.body,
      createdBy: userId,
    });
    res.status(HTTP_STATUS.CREATED).json(new ApiResponse(result));
  });

  getRoom = asyncHandler(async (req: Request, res: Response) => {
    const roomId = req.params.roomId as string;
    const room = await this.service.getRoom(roomId);
    res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(room, t("CHAT_GROUP_FETCHED", req.locale)));
  });

  update = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    const room = await this.service.updateRoom(roomId, userId, req.body);
    res.status(HTTP_STATUS.OK).json(new ApiResponse(room));
  });

  disband = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    const room = await this.service.disbandGroup(roomId, userId);
    res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(room, t("CHAT_GROUP_DISBANDED", req.locale)));
  });

  getUserGroups = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const cursor = req.query.cursor as string | undefined;
    const limit = Number(req.query.limit) || 20;
    const page = Number(req.query.page) || 1;
    const [groups, totalCount] = await Promise.all([
      this.service.getUserGroups(userId, { limit, cursor }),
      this.service.countUserGroups(userId),
    ]);
    const paginated = buildPaginatedResponse(
      groups as unknown as Record<string, unknown>[],
      totalCount,
      page,
      limit,
      "lastMessageAt"
    );
    const msg = paginated.data.length
      ? t("CHAT_GROUPS_FETCHED", req.locale)
      : t("CHAT_NO_GROUPS_FOUND", req.locale);
    res.status(HTTP_STATUS.OK).json(new ApiResponse(paginated, msg));
  });
}
