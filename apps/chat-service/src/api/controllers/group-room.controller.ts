import type { Request, Response } from "express";

import { ApiResponse, asyncHandler } from "@aimess/utils";
import { HTTP_STATUS, t } from "@aimess/constants";

import { buildPaginatedResponse } from "../../lib/pagination.js";
import type { GroupRoomService } from "../../services/group-room.service.js";
import type { GroupAutoDeleteService } from "../../services/group-auto-delete.service.js";

export class GroupRoomController {
  constructor(
    private readonly service: GroupRoomService,
    private readonly autoDeleteService: GroupAutoDeleteService
  ) {}

  // Automatically Delete Messages (disappearing messages). ONE timer for the
  // whole group: any member may read it, only an admin/moderator may change it,
  // and every member's messages then follow it.
  getAutoDelete = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    const result = await this.autoDeleteService.getSettings(roomId, userId);
    res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(result, t("CHAT_AUTO_DELETE_FETCHED", req.locale)));
  });

  setAutoDelete = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    const { mode, ttlSeconds } = req.body as {
      mode: string;
      ttlSeconds?: number | null;
    };
    const result = await this.autoDeleteService.updateSetting(roomId, userId, {
      mode,
      ttlSeconds: ttlSeconds ?? null,
    });
    res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(result, t("CHAT_AUTO_DELETE_UPDATED", req.locale)));
  });

  create = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const result = await this.service.createGroup({
      ...req.body,
      createdBy: userId,
    });
    res.status(HTTP_STATUS.CREATED).json(new ApiResponse(result));
  });

  getRoom = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    const room = await this.service.getRoom(roomId, userId);
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
    const q = (req.query.q as string | undefined)?.trim() || undefined;
    const [groups, totalCount] = await Promise.all([
      this.service.getUserGroups(userId, { limit, cursor, q }),
      this.service.countUserGroups(userId, q),
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

  clearConversation = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    await this.service.clearConversation(roomId, userId);
    res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(null, t("CHAT_CONVERSATION_DELETED", req.locale)));
  });

  clearChat = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    await this.service.clearChat(roomId, userId);
    res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(null, t("CHAT_CLEARED", req.locale)));
  });

  archiveRoom = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    const result = await this.service.archiveRoom(roomId, userId);
    res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(result, t("CHAT_ROOM_ARCHIVED", req.locale)));
  });

  unarchiveRoom = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    const result = await this.service.unarchiveRoom(roomId, userId);
    res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(result, t("CHAT_ROOM_UNARCHIVED", req.locale)));
  });
}
