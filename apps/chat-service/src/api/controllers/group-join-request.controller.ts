import type { Request, Response } from "express";

import { ApiResponse, asyncHandler } from "@aimess/utils";
import { HTTP_STATUS } from "@aimess/constants";

import type { GroupJoinRequestService } from "../../services/group-join-request.service.js";
import type { GroupMemberService } from "../../services/group-member.service.js";

export class GroupJoinRequestController {
  constructor(
    private readonly service: GroupJoinRequestService,
    private readonly memberService: GroupMemberService
  ) {}

  listForRoom = asyncHandler(async (req: Request, res: Response) => {
    const result = await this.service.listForRoom(
      req.params.roomId as string,
      req.auth.userId,
      {
        cursor: typeof req.query.cursor === "string" ? req.query.cursor : undefined,
        limit: Number(req.query.limit) || undefined,
      }
    );
    res.status(HTTP_STATUS.OK).json(new ApiResponse(result));
  });

  listMine = asyncHandler(async (req: Request, res: Response) => {
    res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(await this.service.listMine(req.auth.userId)));
  });

  approve = asyncHandler(async (req: Request, res: Response) => {
    const request = await this.service.approve(
      req.params.requestId as string,
      req.auth.userId,
      this.memberService
    );
    res.status(HTTP_STATUS.OK).json(new ApiResponse({ request }));
  });

  reject = asyncHandler(async (req: Request, res: Response) => {
    const request = await this.service.reject(
      req.params.requestId as string,
      req.auth.userId
    );
    res.status(HTTP_STATUS.OK).json(new ApiResponse({ request }));
  });

  cancel = asyncHandler(async (req: Request, res: Response) => {
    const request = await this.service.cancel(
      req.params.requestId as string,
      req.auth.userId
    );
    res.status(HTTP_STATUS.OK).json(new ApiResponse({ request }));
  });
}
