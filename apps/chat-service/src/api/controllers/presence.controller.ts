import type { Request, Response } from "express";

import { ApiResponse, asyncHandler } from "@aimess/utils";
import { HTTP_STATUS } from "@aimess/constants";

import type { PresenceService } from "../../services/presence.service.js";

export class PresenceController {
  constructor(private readonly presenceService: PresenceService) {}

  /**
   * Peer presence, viewer-scoped. `whoCanSeeOnlineStatus` is enforced here and
   * not only on the socket `presence:subscribe` path — otherwise this endpoint
   * is a trivial bypass of the exact setting that gate exists to protect.
   * A denied viewer sees `{isOnline: false, lastSeen: null}`: the same shape a
   * genuinely-offline peer returns, so the setting itself stays undisclosed.
   */
  getPresence = asyncHandler(async (req: Request, res: Response) => {
    const userId = req.params.userId as string;
    const { userId: viewerId } = req.auth;
    // One viewer-scoped read for status + lastSeen + version, so a client
    // hydrating from REST starts with the same version the socket events
    // carry and can tell a late event from a newer one.
    const view = (
      await this.presenceService.getPresenceViewsFor(viewerId, [userId])
    ).get(userId);
    res.status(HTTP_STATUS.OK).json(
      new ApiResponse({
        userId,
        isOnline: view?.isOnline ?? false,
        lastSeen: view?.lastSeen ?? null,
        version: view?.version ?? 0,
      })
    );
  });
}
