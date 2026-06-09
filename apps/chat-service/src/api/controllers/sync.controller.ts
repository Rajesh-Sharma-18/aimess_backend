import type { Request, Response } from "express";

import { ApiResponse, asyncHandler } from "@aimess/utils";
import { ForbiddenError } from "@aimess/errors";
import { HTTP_STATUS } from "@aimess/constants";

import type { SyncService } from "../../services/sync.service.js";

export class SyncController {
  constructor(private readonly service: SyncService) {}

  /**
   * GET /api/chat/sync — per-conversation seq-based incremental sync.
   *
   * Query:
   *   conv_id=<roomId>   required — the conversation to gap-fill
   *   from_seq=<n>       optional — return events with sequenceNumber > from_seq (default 0)
   *   limit=<n>          optional — page size 1..200 (default 50)
   *   type=private|group optional — skips the private/group auto-probe
   *
   * Response: { events: [...], next_seq, has_more, conversationType }
   * Re-request with from_seq = next_seq until has_more === false.
   */
  getSync = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const convId = req.query.conv_id as string;
    const fromSeq = req.query.from_seq != null ? Number(req.query.from_seq) : 0;
    const limit = Number(req.query.limit) || 50;
    const type = req.query.type as "private" | "group" | undefined;

    const result = await this.service.getRoomSync({
      userId,
      convId,
      fromSeq,
      limit,
      type,
    });

    if (!result.authorized) {
      throw new ForbiddenError("CHAT_NOT_A_PARTICIPANT");
    }

    res.status(HTTP_STATUS.OK).json(
      new ApiResponse({
        events: result.events,
        next_seq: result.next_seq,
        has_more: result.has_more,
        conversationType: result.conversationType,
      })
    );
  });
}
