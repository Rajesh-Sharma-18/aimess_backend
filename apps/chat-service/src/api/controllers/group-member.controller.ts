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
    const { reason } = req.body as { reason?: string };
    const result = await this.service.leave(roomId, userId, reason);
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

  ban = asyncHandler(async (req: Request, res: Response) => {
    const { userId: bannedBy } = req.auth;
    const { roomId, userId, reason } = req.body;
    const result = await this.service.ban({
      roomId,
      targetUserId: userId,
      bannedBy,
      reason,
    });
    res.status(HTTP_STATUS.OK).json(new ApiResponse(result));
  });

  unban = asyncHandler(async (req: Request, res: Response) => {
    const { userId: unbannedBy } = req.auth;
    const { roomId, userId } = req.body;
    const result = await this.service.unban({
      roomId,
      targetUserId: userId,
      unbannedBy,
    });
    res.status(HTTP_STATUS.OK).json(new ApiResponse(result));
  });

  reportMember = asyncHandler(async (req: Request, res: Response) => {
    const { userId: reporterId } = req.auth;
    const { roomId, userId, reason, description } = req.body;
    const result = await this.service.reportMember({
      roomId,
      targetUserId: userId,
      reporterId,
      reason,
      description,
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

  muteMember = asyncHandler(async (req: Request, res: Response) => {
    const { userId: mutedBy } = req.auth;
    const { roomId, userId, durationMinutes, mutedUntil } = req.body as {
      roomId: string;
      userId: string;
      durationMinutes?: number | null;
      mutedUntil?: string | null;
    };
    // `durationMinutes` (server clock) wins over a client-computed absolute
    // `mutedUntil` — mirrors community's setMemberMuteSchema handling.
    const resolvedMutedUntil =
      durationMinutes !== undefined
        ? durationMinutes == null
          ? null
          : new Date(Date.now() + durationMinutes * 60_000)
        : mutedUntil
          ? new Date(mutedUntil)
          : null;
    const result = await this.service.muteMember({
      roomId,
      targetUserId: userId,
      mutedBy,
      mutedUntil: resolvedMutedUntil,
    });
    res.status(HTTP_STATUS.OK).json(new ApiResponse(result));
  });

  unmuteMember = asyncHandler(async (req: Request, res: Response) => {
    const { userId: actorId } = req.auth;
    const { roomId, userId } = req.body as { roomId: string; userId: string };
    const result = await this.service.unmuteMember({
      roomId,
      targetUserId: userId,
      actorId,
    });
    res.status(HTTP_STATUS.OK).json(new ApiResponse(result));
  });

  getMembers = asyncHandler(async (req: Request, res: Response) => {
    const roomId = req.params.roomId as string;
    const { userId } = req.auth;
    const limit = Number(req.query.limit) || 50;
    const cursor = req.query.cursor as string | undefined;
    const page = Number(req.query.page) || 1;
    // Roster read is membership-gated in the service (throws before the count
    // query matters), so run it first rather than in parallel with the count.
    const members = await this.service.getMembers(
      roomId,
      { limit, cursor },
      userId
    );
    const totalCount = await this.service.countMembers(roomId);
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
