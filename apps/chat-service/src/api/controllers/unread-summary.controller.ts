import type { Request, Response } from "express";

import { ApiResponse, asyncHandler } from "@aimess/utils";
import { HTTP_STATUS, t } from "@aimess/constants";

import type { UnreadSummaryService } from "../../services/unread-summary.service.js";

export class UnreadSummaryController {
  constructor(private readonly service: UnreadSummaryService) {}

  /**
   * GET /api/chat/unread-summary — combined unread totals for the main nav
   * badges: { privateUnread, groupUnread, communityUnread, chatUnread }.
   */
  getUnreadSummary = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const summary = await this.service.getUnreadSummary(userId);
    res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(summary, t("CHAT_UNREAD_COUNT_FETCHED", req.locale))
      );
  });
}
