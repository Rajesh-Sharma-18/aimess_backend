import type { Request, Response } from "express";

import { ApiResponse, asyncHandler } from "@aimess/utils";
import { HTTP_STATUS, t, type MessageKey } from "@aimess/constants";

import { buildListResponse } from "../../lib/pagination.js";
import type { GroupInviteLinkService } from "../../services/group-invite-link.service.js";
import type { GroupMemberService } from "../../services/group-member.service.js";

export class GroupInviteLinkController {
  constructor(
    private readonly service: GroupInviteLinkService,
    private readonly memberService: GroupMemberService
  ) {}

  create = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const link = await this.service.create({ ...req.body, userId });
    res.status(HTTP_STATUS.CREATED).json(new ApiResponse(link));
  });

  revoke = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const { token } = req.body;
    const result = await this.service.revoke(token, userId);
    res.status(HTTP_STATUS.OK).json(new ApiResponse(result));
  });

  preview = asyncHandler(async (req: Request, res: Response) => {
    const token = req.params.token as string;
    const result = await this.service.preview(token);
    res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(
          result,
          t("CHAT_INVITE_LINK_PREVIEW_FETCHED", req.locale)
        )
      );
  });

  join = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const { token } = req.body;
    const result = await this.service.join(token, userId, this.memberService);
    res.status(HTTP_STATUS.OK).json(new ApiResponse(result));
  });

  bulkSend = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    const { userIds, token } = req.body;
    const result = await this.service.bulkSend({
      roomId,
      callerId: userId,
      userIds,
      token,
    });
    // Per-recipient failures ride inside a 200 (partial-success contract), so
    // the error-handler never localizes them — do it here. `code` stays the
    // stable machine value clients switch on.
    res.status(HTTP_STATUS.OK).json(
      new ApiResponse({
        ...result,
        results: result.results.map((r) =>
          r.code ? { ...r, message: t(r.code as MessageKey, req.locale) } : r
        ),
      })
    );
  });

  getActiveLinks = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const roomId = req.params.roomId as string;
    const limit = Number(req.query.limit) || 20;
    const page = Number(req.query.page) || 1;
    // Authorize (active ADMIN) before listing tokens; the count query is
    // harmless and only surfaces if authorization passes.
    const links = await this.service.getActiveLinks(roomId, userId);
    const totalCount = await this.service.countActiveLinks(roomId);
    const paginated = buildListResponse(links, totalCount, page, limit);
    const msg = paginated.data.length
      ? t("CHAT_INVITE_LINKS_FETCHED", req.locale)
      : t("CHAT_NO_INVITE_LINKS_FOUND", req.locale);
    res.status(HTTP_STATUS.OK).json(new ApiResponse(paginated, msg));
  });
}
