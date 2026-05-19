import type { Request, Response } from "express";

import { HTTP_STATUS, t } from "@aimess/constants";
import { ApiResponse, asyncHandler } from "@aimess/utils";

import type {
  LinkAppleInput,
  LinkGoogleInput,
  UnlinkSocialInput,
} from "../validators/social-link.validator.js";
import { socialLinkService } from "../../services/social-link.service.js";

export const linkGoogle = asyncHandler(async (req: Request, res: Response) => {
  const body = req.body as LinkGoogleInput;
  const result = await socialLinkService.linkGoogle(req.auth.userId, body);

  return res
    .status(HTTP_STATUS.OK)
    .json(new ApiResponse(result, t("AUTH_SOCIAL_LINK_SUCCESS", req.locale)));
});

export const linkApple = asyncHandler(async (req: Request, res: Response) => {
  const body = req.body as LinkAppleInput;
  const result = await socialLinkService.linkApple(req.auth.userId, body);

  return res
    .status(HTTP_STATUS.OK)
    .json(new ApiResponse(result, t("AUTH_SOCIAL_LINK_SUCCESS", req.locale)));
});

export const unlinkSocial = asyncHandler(
  async (req: Request, res: Response) => {
    const body = req.body as UnlinkSocialInput;
    const result = await socialLinkService.unlink(req.auth.userId, body);

    return res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(result, t("AUTH_SOCIAL_UNLINK_SUCCESS", req.locale))
      );
  }
);
