import type { Request, Response } from "express";

import { HTTP_STATUS, t } from "@aimess/constants";
import { ApiResponse, asyncHandler } from "@aimess/utils";

import type {
  AppleLoginInput,
  GoogleLoginInput,
} from "../validators/social-auth.validator.js";
import { setLoginRefreshCookie } from "../../lib/auth-cookie.js";
import { socialAuthService } from "../../services/social-auth.service.js";

export const loginWithGoogle = asyncHandler(
  async (req: Request, res: Response) => {
    const body = req.body as GoogleLoginInput;
    const result = await socialAuthService.loginWithGoogle(req, body);
    // Social login has no rememberMe flag, so this is a session cookie.
    setLoginRefreshCookie(res, result.tokens);

    return res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(result, t("AUTH_SOCIAL_LOGIN_SUCCESS", req.locale))
      );
  }
);

export const loginWithApple = asyncHandler(
  async (req: Request, res: Response) => {
    const body = req.body as AppleLoginInput;
    const result = await socialAuthService.loginWithApple(req, body);
    setLoginRefreshCookie(res, result.tokens);

    return res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(result, t("AUTH_SOCIAL_LOGIN_SUCCESS", req.locale))
      );
  }
);
