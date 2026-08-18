import type { Request, Response } from "express";
import {
  CALL_HISTORY_FILTERS,
  type CallHistoryFilter,
} from "@aimess/constants";
import { ApiResponse, asyncHandler } from "@aimess/utils";
import { NotFoundError } from "@aimess/errors";
import { HTTP_STATUS } from "@aimess/constants";
import type { CallService } from "../../services/call.service.js";
import type { CallHistoryService } from "../../services/call-history.service.js";

const readFilter = (value: unknown): CallHistoryFilter => {
  const filter = String(value ?? "all") as CallHistoryFilter;
  return CALL_HISTORY_FILTERS.includes(filter) ? filter : "all";
};

export class CallController {
  constructor(
    private readonly callService: CallService,
    private readonly callHistoryService: CallHistoryService
  ) {}

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

  /**
   * WhatsApp-style Calls list: consecutive identical attempts collapsed into one
   * row, filtered server-side by tab so paging stays correct.
   * Separate from `getCallHistory` on purpose — that raw feed is a published
   * contract (mobile pages it), and grouping changes what a "page" means.
   */
  getGroupedCallHistory = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const cursor = req.query.cursor as string | undefined;
    const limit = Number(req.query.limit) || 20;
    const result = await this.callHistoryService.getHistory({
      userId,
      filter: readFilter(req.query.filter),
      cursor: cursor ?? null,
      limit,
    });
    res.status(HTTP_STATUS.OK).json(new ApiResponse(result));
  });

  getCallById = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const callId = req.params.callId as string;
    const call = await this.callService.getCallByCallId(callId, userId);
    if (!call) throw new NotFoundError("CALL_NOT_FOUND");
    res.status(HTTP_STATUS.OK).json(new ApiResponse(call));
  });
}
