import type { Request, Response } from "express";

import { ApiResponse, asyncHandler } from "@aimess/utils";
import { HTTP_STATUS, t } from "@aimess/constants";

import type { PaginatedResponse } from "../../lib/pagination.js";
import type { InboxService, InboxItem } from "../../services/inbox.service.js";

export class InboxController {
  constructor(private readonly service: InboxService) {}

  /**
   * GET /api/chat/inbox — unified, timestamp-ordered list of the user's private
   * rooms and group chats.
   *
   * Query (epoch ms, mutually exclusive; omit both for the newest page):
   *   before_ts=<ms>&limit=20  → items with lastMessageAt <= before_ts (newest-first)
   *   after_ts=<ms>&limit=20   → items with lastMessageAt >= after_ts  (oldest-first)
   */
  getInbox = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;

    const beforeTs =
      req.query.before_ts != null ? Number(req.query.before_ts) : undefined;
    const afterTs =
      req.query.after_ts != null ? Number(req.query.after_ts) : undefined;
    const limit = Number(req.query.limit) || 20;

    const direction = afterTs != null ? "after" : "before";
    const tsMs =
      afterTs != null ? afterTs : beforeTs != null ? beforeTs : Date.now();

    const result = await this.service.getInbox({
      userId,
      direction,
      ts: new Date(tsMs),
      limit,
    });

    const paginated: PaginatedResponse<InboxItem> = {
      pagination: {
        totalData: result.total,
        totalPage: Math.ceil(result.total / limit) || 1,
        currentPage: 1,
        limit,
        nextCursor: result.nextCursor,
        hasMore: result.hasMore,
      },
      data: result.items,
    };

    const msg = result.items.length
      ? t("CHAT_INBOX_FETCHED", req.locale)
      : t("CHAT_NO_INBOX_FOUND", req.locale);
    res.status(HTTP_STATUS.OK).json(new ApiResponse(paginated, msg));
  });
}
