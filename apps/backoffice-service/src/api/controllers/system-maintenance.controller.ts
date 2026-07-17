import type { RequestHandler } from "express";
import { HTTP_STATUS } from "@aimess/constants";

import { systemMaintenanceService } from "../../services/index.js";
import { getRequestContext } from "../../lib/request-context.js";

/**
 * POST /v1/system/friendships/disconnect-all — platform-wide unfriend sweep.
 * `confirm: true` is enforced by the route's validator before this ever runs;
 * `requirePermission(PERMISSIONS.SETTINGS_MANAGE)` on the route is the actual
 * access control (SUPER_ADMIN only).
 */
export const disconnectAllFriendships: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const result = await systemMaintenanceService.disconnectAllFriendships(
        req.admin!.id,
        getRequestContext(req)
      );
      res.status(HTTP_STATUS.OK).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  })();
};
