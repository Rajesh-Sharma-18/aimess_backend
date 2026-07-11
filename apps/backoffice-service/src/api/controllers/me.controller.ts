import type { RequestHandler } from "express";

import { getRequestContext } from "../../lib/request-context.js";
import { adminAuthService } from "../../services/index.js";
import { HTTP_STATUS } from "@aimess/constants";
import type {
  ChangePasswordInput,
  UpdateMeInput,
} from "../validators/index.js";

/** GET /v1/me — current admin profile + resolved permissions. */
export const getMe: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const profile = await adminAuthService.getMe(req.admin!.id);
      res.status(HTTP_STATUS.OK).json({
        success: true,
        data: profile,
      });
    } catch (error) {
      next(error);
    }
  })();
};

/** PATCH /v1/me — self-service update: username, email, avatar. */
export const updateMe: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const body = req.body as UpdateMeInput;
      const profile = await adminAuthService.updateMe(
        req.admin!.id,
        body,
        getRequestContext(req)
      );
      res.status(HTTP_STATUS.OK).json({
        success: true,
        message: "Profile updated",
        data: profile,
      });
    } catch (error) {
      next(error);
    }
  })();
};

/** PATCH /v1/change-password — self-service password change. */
export const changePassword: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const body = req.body as ChangePasswordInput;
      await adminAuthService.changePassword(
        req.admin!.id,
        {
          currentPassword: body.currentPassword,
          newPassword: body.newPassword,
        },
        { ...getRequestContext(req), sessionId: req.admin!.sid }
      );
      res.status(HTTP_STATUS.OK).json({
        success: true,
        message: "Password changed",
        data: { passwordChanged: true },
      });
    } catch (error) {
      next(error);
    }
  })();
};
