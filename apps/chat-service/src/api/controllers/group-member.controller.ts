import type { Request, Response } from "express";

import { ApiResponse, asyncHandler } from "@aimess/utils";
import { HTTP_STATUS, t } from "@aimess/constants";

import { buildPaginatedResponse } from "../../lib/pagination.js";
import type { GroupMemberService } from "../../services/group-member.service.js";

export class GroupMemberController {
  constructor(private readonly service: GroupMemberService) {}

  addMember = asyncHandler(async (req: Request, res: Response) => {
    const { userId: actorId } = req.auth;
    const { roomId, userId } = req.body;
    const member = await this.service.addMember({
      roomId,
      userId,
      invitedBy: actorId,
    });
    res.status(HTTP_STATUS.CREATED).json(new ApiResponse(member));
  });

  leave = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    const result = await this.service.leave(roomId, userId);
    res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(result, t("CHAT_GROUP_LEFT", req.locale)));
  });

  kick = asyncHandler(async (req: Request, res: Response) => {
    const { userId: kickedBy } = req.auth;
    const { roomId, userId, reason } = req.body;
    const result = await this.service.kick({
      roomId,
      targetUserId: userId,
      kickedBy,
      reason,
    });
    res.status(HTTP_STATUS.OK).json(new ApiResponse(result));
  });

  updateRole = asyncHandler(async (req: Request, res: Response) => {
    const { userId: actorUserId } = req.auth;
    const { roomId, userId, role } = req.body;
    const result = await this.service.updateRole({
      roomId,
      targetUserId: userId,
      newRole: role,
      actorUserId,
    });
    res.status(HTTP_STATUS.OK).json(new ApiResponse(result));
  });

  getMembers = asyncHandler(async (req: Request, res: Response) => {
    const roomId = req.params.roomId as string;
    const limit = Number(req.query.limit) || 50;
    const cursor = req.query.cursor as string | undefined;
    const page = Number(req.query.page) || 1;
    const [members, totalCount] = await Promise.all([
      this.service.getMembers(roomId, { limit, cursor }),
      this.service.countMembers(roomId),
    ]);
    const paginated = buildPaginatedResponse(
      members as unknown as Record<string, unknown>[],
      totalCount,
      page,
      limit,
      "joinedAt"
    );
    const msg = paginated.data.length
      ? t("CHAT_MEMBERS_FETCHED", req.locale)
      : t("CHAT_NO_MEMBERS_FOUND", req.locale);
    res.status(HTTP_STATUS.OK).json(new ApiResponse(paginated, msg));
  });
}
