import type { Request, Response } from "express";

import { HTTP_STATUS, t } from "@aimess/constants";
import { ApiResponse, asyncHandler } from "@aimess/utils";

import type {
  AppleLoginInput,
  GoogleLoginInput,
} from "../validators/social-auth.validator.js";
import { socialAuthService } from "../../services/social-auth.service.js";

export const loginWithGoogle = asyncHandler(
  async (req: Request, res: Response) => {
    const body = req.body as GoogleLoginInput;
    const result = await socialAuthService.loginWithGoogle(req, body);

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

    return res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(result, t("AUTH_SOCIAL_LOGIN_SUCCESS", req.locale))
      );
  }
);
