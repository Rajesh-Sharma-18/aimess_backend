import type { Request, Response } from "express";

import { ApiResponse, asyncHandler } from "@aimess/utils";
import { HTTP_STATUS, renderMessageKey } from "@aimess/constants";

import type {
  ForwardRequest,
  ForwardService,
} from "../../services/forward.service.js";

export class ForwardController {
  constructor(private readonly service: ForwardService) {}

  /** POST /api/chat/forward — copy 1..50 sources into 1..20 target rooms. */
  forward = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.auth;
    const body = req.body as Omit<ForwardRequest, "userId">;
    const results = await this.service.forward({ userId, ...body });
    res.status(HTTP_STATUS.OK).json(
      new ApiResponse({
        results: results.map((r) => ({
          ...r,
          error: r.error
            ? {
                code: r.error.code,
                message:
                  renderMessageKey(r.error.code, req.locale) ?? r.error.code,
              }
            : null,
        })),
      })
    );
  });
}
