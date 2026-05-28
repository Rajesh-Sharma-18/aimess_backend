import type { Request, Response } from "express";
import { ApiResponse, asyncHandler } from "@aimess/utils";
import { NotFoundError } from "@aimess/errors";
import { HTTP_STATUS } from "@aimess/constants";
import type { CallService } from "../../services/call.service.js";

export class CallController {
  constructor(private readonly callService: CallService) {}

  getCallHistory = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const cursor = req.query.cursor as string | undefined;
    const limit = Number(req.query.limit) || 20;
    const result = await this.callService.getCallHistory({
      userId,
      cursor: cursor ?? null,
      limit,
    });
    res.status(HTTP_STATUS.OK).json(new ApiResponse(result));
  });

  getCallById = asyncHandler(async (req: Request, res: Response) => {
    const callId = req.params.callId as string;
    const call = await this.callService.getCallByCallId(callId);
    if (!call) throw new NotFoundError("CALL_NOT_FOUND");
    res.status(HTTP_STATUS.OK).json(new ApiResponse(call));
  });
}
