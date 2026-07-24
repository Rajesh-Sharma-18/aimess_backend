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

/** GET /v1/system/calling — current state of the platform-wide kill-switch. */
export const getCallingEnabled: RequestHandler = (_req, res, next) => {
  void (async () => {
    try {
      const result = await systemMaintenanceService.getCallingEnabled();
      res.status(HTTP_STATUS.OK).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  })();
};

/**
 * PATCH /v1/system/calling — enable/disable calling platform-wide.
 * `requirePermission(PERMISSIONS.SETTINGS_MANAGE)` on the route is the access
 * control (SUPER_ADMIN only). Disabling blocks NEW calls only.
 */
export const setCallingEnabled: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const { enabled } = req.body as { enabled: boolean };
      const result = await systemMaintenanceService.setCallingEnabled(
        enabled,
        req.admin!.id,
        getRequestContext(req)
      );
      res.status(HTTP_STATUS.OK).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  })();
};
