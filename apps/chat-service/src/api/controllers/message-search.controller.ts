import type { Request, Response } from "express";

import { ApiResponse, asyncHandler } from "@aimess/utils";
import { HTTP_STATUS, t } from "@aimess/constants";

import type { MessageSearchService } from "../../services/message-search.service.js";

export class MessageSearchController {
  constructor(private readonly service: MessageSearchService) {}

  /**
   * GET /api/chat/messages/search?q=&limit=&cursor=
   *
   * Message-BODY search across every conversation the caller can read — private,
   * group and community in one time-ordered list. The per-room
   * `/rooms/:roomId/messages/search` endpoints are unchanged; this is the
   * whole-account one that backs global search.
   *
   * `cursor` is the same `<createdAtMs>_<messageId>` keyset the per-room searches
   * emit; echo `nextCursor` back verbatim.
   */
  search = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const query = ((req.query.q as string) ?? "").trim();
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
    const cursor = req.query.cursor != null ? String(req.query.cursor) : null;

    // An empty term is not an error, it is "nothing to search" — same shape the
    // per-room search returns so a client renders one empty state either way.
    if (!query) {
      res
        .status(HTTP_STATUS.OK)
        .json(
          new ApiResponse(
            { data: [], hasMore: false, nextCursor: null },
            t("CHAT_NO_MESSAGES_FOUND", req.locale)
          )
        );
      return;
    }

    const result = await this.service.search({
      userId,
      query,
      limit,
      cursor,
    });

    res.status(HTTP_STATUS.OK).json(
      new ApiResponse(
        {
          data: result.hits,
          hasMore: result.hasMore,
          nextCursor: result.nextCursor,
        },
        t(
          result.hits.length ? "CHAT_MESSAGES_SEARCHED" : "CHAT_NO_MESSAGES_FOUND",
          req.locale
        )
      )
    );
  });
}
