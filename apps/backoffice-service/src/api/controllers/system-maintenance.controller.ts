import type { RequestHandler } from "express";
import { ApiResponse } from "@aimess/utils";
import { HTTP_STATUS, t } from "@aimess/constants";

import {
  appUpdatePolicyService,
  systemMaintenanceService,
} from "../../services/index.js";
import type { AppUpdatePolicyInput } from "../validators/index.js";
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
      res
        .status(HTTP_STATUS.OK)
        .json(
          new ApiResponse(
            result,
            t("ADMIN_FRIENDSHIPS_DISCONNECTED", req.locale)
          )
        );
    } catch (error) {
      next(error);
    }
  })();
};

/** GET /v1/system/calling — current state of the platform-wide kill-switch. */
export const getCallingEnabled: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const result = await systemMaintenanceService.getCallingEnabled();
      res
        .status(HTTP_STATUS.OK)
        .json(
          new ApiResponse(result, t("ADMIN_CALLING_STATE_FETCHED", req.locale))
        );
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
      res
        .status(HTTP_STATUS.OK)
        .json(
          new ApiResponse(result, t("ADMIN_CALLING_STATE_UPDATED", req.locale))
        );
    } catch (error) {
      next(error);
    }
  })();
};

/** GET /v1/system/app-update-policy — the admin update policy for both platforms. */
export const getAppUpdatePolicy: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const result = await appUpdatePolicyService.get();
      res
        .status(HTTP_STATUS.OK)
        .json(
          new ApiResponse(result, t("ADMIN_APP_UPDATE_POLICY_FETCHED", req.locale))
        );
    } catch (error) {
      next(error);
    }
  })();
};

/**
 * PUT /v1/system/app-update-policy — replace the policy for both platforms.
 * Live on every gateway within ~10 s (the gateway's policy cache window).
 */
export const setAppUpdatePolicy: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const result = await appUpdatePolicyService.set(
        req.body as AppUpdatePolicyInput,
        req.admin!.id,
        getRequestContext(req)
      );
      res
        .status(HTTP_STATUS.OK)
        .json(
          new ApiResponse(result, t("ADMIN_APP_UPDATE_POLICY_UPDATED", req.locale))
        );
    } catch (error) {
      next(error);
    }
  })();
};
