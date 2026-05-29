import type { Request, Response } from "express";

import { ApiResponse, asyncHandler } from "@aimess/utils";
import { HTTP_STATUS } from "@aimess/constants";

import type { PresenceService } from "../../services/presence.service.js";

export class PresenceController {
  constructor(private readonly presenceService: PresenceService) {}

  getPresence = asyncHandler(async (req: Request, res: Response) => {
    const userId = req.params.userId as string;
    const [isOnline, lastSeen] = await Promise.all([
      this.presenceService.getPresence(userId),
      this.presenceService.getLastSeen(userId),
    ]);
    res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse({ userId, isOnline, lastSeen }));
  });
}
