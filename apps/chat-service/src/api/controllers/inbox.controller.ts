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
   * Two pagination modes, checked in this order (omit all for the newest page):
   *
   *   before_cursor / after_cursor (PREFERRED) — the opaque compound
   *     `(lastMessageAt, roomId)` keyset token. Boundaries are EXCLUSIVE, so
   *     consecutive pages never share a row when two conversations tie on
   *     `lastMessageAt`. Echo `pagination.nextCursor` back verbatim.
   *   before_ts / after_ts (legacy, epoch ms) — a bare INCLUSIVE bound:
   *     before_ts → lastMessageAt <= before_ts (newest-first)
   *     after_ts  → lastMessageAt >= after_ts  (oldest-first)
   *     Pages share the boundary row on a tie; clients de-dupe by roomId.
   *
   * Both modes share the same service call, items and response envelope — only
   * the DB boundary differs.
   */
  getInbox = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const limit = Number(req.query.limit) || 20;

    // Compound-cursor mode wins when present: it is the strictly better boundary.
    // The token is "<ms>_<roomId>" — `parseTsCursor` splits on the FIRST "_" so
    // the roomId's own "prv_"/"grp_" prefix survives intact.
    const rawCursor =
      req.query.after_cursor != null
        ? String(req.query.after_cursor)
        : req.query.before_cursor != null
          ? String(req.query.before_cursor)
          : undefined;

    if (rawCursor != null) {
      const cursor = parseTsCursor(rawCursor);
      const result = await this.service.getInbox({
        userId,
        direction: req.query.after_cursor != null ? "after" : "before",
        ts: new Date(cursor ? cursor.ms : Date.now()),
        boundaryId: cursor?.id ?? null,
        // A cursor page is exclusive so it never re-returns its own boundary row.
        inclusive: cursor == null,
        compoundCursor: true,
        limit,
      });

      this.send(req, res, result, limit);
      return;
    }

    const beforeTs =
      req.query.before_ts != null ? Number(req.query.before_ts) : undefined;
    const afterTs =
      req.query.after_ts != null ? Number(req.query.after_ts) : undefined;

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

  /** Shared response envelope — identical for both pagination modes. */
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
