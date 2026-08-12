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
   *     They also accept the compound token, since that is what `nextCursor`
   *     now always returns.
   *
   * `nextCursor` is ALWAYS the compound token, in both modes. It used to be a
   * bare epoch-ms in legacy mode, and the doc above tells clients to echo
   * `nextCursor` into `before_cursor` — a bare value there parses to a boundary
   * with NO tiebreaker, which turns the exclusive keyset into a plain
   * `lastMessageAt < ts` and silently drops EVERY conversation sharing that
   * millisecond, permanently. Emitting the tiebreaker on every page is what
   * makes "echo it back verbatim" safe whichever param the client uses.
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
    const after = req.query.after_cursor ?? req.query.after_ts;
    const before = req.query.before_cursor ?? req.query.before_ts;
    const rawCursor =
      after != null
        ? String(after)
        : before != null
          ? String(before)
          : undefined;
    const cursor = rawCursor != null ? parseTsCursor(rawCursor) : null;

    // A continuation token (one carrying the roomId tiebreaker) is EXCLUSIVE so
    // a page never re-returns its own boundary row. A bare epoch-ms keeps the
    // legacy INCLUSIVE meaning — it is a coarse "give me everything at or before
    // this instant" jump, not a continuation.
    const result = await this.service.getInbox({
      userId,
      direction: after != null ? "after" : "before",
      ts: new Date(cursor ? cursor.ms : Date.now()),
      boundaryId: cursor?.id ?? null,
      inclusive: cursor?.id == null,
      compoundCursor: true,
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
