import type { RequestHandler } from "express";
import { ApiResponse } from "@aimess/utils";

import { getRequestContext } from "../../lib/request-context.js";
import { adminAuthService } from "../../services/index.js";
import type { LoginInput, RefreshInput } from "../validators/index.js";
import { HTTP_STATUS, t } from "@aimess/constants";

/** POST /v1/auth/login — single-step (email + password). */
export const login: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const { email, password } = req.body as LoginInput;
      const result = await adminAuthService.login(
        email,
        password,
        getRequestContext(req)
      );
      res
        .status(HTTP_STATUS.OK)
        .json(new ApiResponse(result, t("ADMIN_LOGIN_SUCCESS", req.locale)));
    } catch (error) {
      next(error);
    }
  })();
};

/** POST /v1/auth/refresh — rotate the admin token pair. */
export const refresh: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const { refreshToken } = req.body as RefreshInput;
      const result = await adminAuthService.refresh(
        refreshToken,
        getRequestContext(req)
      );
      res
        .status(HTTP_STATUS.OK)
        .json(new ApiResponse(result, t("ADMIN_TOKEN_REFRESHED", req.locale)));
    } catch (error) {
      next(error);
    }
  })();
};

/** POST /v1/auth/logout — revoke the current session. */
export const logout: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const admin = req.admin!;
      await adminAuthService.logout(
        admin.id,
        admin.sid,
        getRequestContext(req)
      );
      res
        .status(HTTP_STATUS.OK)
        .json(
          new ApiResponse(
            { loggedOut: true },
            t("ADMIN_LOGOUT_SUCCESS", req.locale)
          )
        );
    } catch (error) {
      next(error);
    }
  })();
};
