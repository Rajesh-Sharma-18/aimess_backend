import type { Request, Response } from "express";

import { ApiResponse, asyncHandler } from "@aimess/utils";
import { HTTP_STATUS, t } from "@aimess/constants";

import { parseTsCursor, type PaginatedResponse } from "../../lib/pagination.js";
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

    this.send(req, res, result, limit);
  });

  /**
   * `GET /api/v2/chat/inbox` — Cursor V2. Same service, same items, same
   * envelope; the ONLY change is pagination: `before_cursor`/`after_cursor`
   * carry the opaque compound `(lastMessageAt, roomId)` keyset token instead of
   * V1's inclusive bare epoch-ms `before_ts`/`after_ts`, so consecutive pages no
   * longer share a boundary row when timestamps tie (no client de-dupe needed).
   * `nextCursor` is that same opaque token — echo it back verbatim.
   *
   * A bare epoch-ms is accepted as a coarse jump (exclusive, no tiebreaker),
   * matching the community V2 cursor contract. Omit both for the newest page.
   */
  getInboxV2 = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const limit = Number(req.query.limit) || 20;

    const raw =
      req.query.after_cursor != null
        ? String(req.query.after_cursor)
        : req.query.before_cursor != null
          ? String(req.query.before_cursor)
          : undefined;
    const direction = req.query.after_cursor != null ? "after" : "before";

    // Compound token "<ms>_<roomId>"; split on the FIRST "_" so the roomId's own
    // "prv_"/"grp_" prefix survives intact.
    const cursor = parseTsCursor(raw);

    const result = await this.service.getInbox({
      userId,
      direction,
      ts: new Date(cursor ? cursor.ms : Date.now()),
      boundaryId: cursor?.id ?? null,
      // No cursor → newest page, inclusive of the newest row. A cursor page is
      // exclusive so it never re-returns its own boundary row.
      inclusive: cursor == null,
      compoundCursor: true,
      limit,
    });

    this.send(req, res, result, limit);
  });

  /** Shared response envelope — identical for V1 and V2. */
  private send(
    req: Request,
    res: Response,
    result: Awaited<ReturnType<InboxService["getInbox"]>>,
    limit: number
  ) {

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
      hasMore: result.hasMore,
      nextCursor: result.nextCursor,
    };

    const msg = result.items.length
      ? t("CHAT_INBOX_FETCHED", req.locale)
      : t("CHAT_NO_INBOX_FOUND", req.locale);
    res.status(HTTP_STATUS.OK).json(new ApiResponse(paginated, msg));
  }
}
