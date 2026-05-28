import type { Request, Response } from "express";

import { HTTP_STATUS, t } from "@aimess/constants";
import { ApiResponse, asyncHandler } from "@aimess/utils";

import type {
  RequestLinkEmailOtpInput,
  VerifyLinkEmailOtpInput,
} from "../validators/email-link.validator.js";
import { emailLinkService } from "../../services/email-link.service.js";

export const requestLinkEmailOtp = asyncHandler(
  async (req: Request, res: Response) => {
    const body = req.body as RequestLinkEmailOtpInput;
    const result = await emailLinkService.requestOtp(
      req,
      req.auth.userId,
      body
    );

    return res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(null, t(result.messageKey, req.locale)));
  }
);

export const verifyLinkEmailOtp = asyncHandler(
  async (req: Request, res: Response) => {
    const body = req.body as VerifyLinkEmailOtpInput;
    const result = await emailLinkService.verifyAndLink(req.auth.userId, body);

    return res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(result, t("AUTH_LINK_EMAIL_SUCCESS", req.locale)));
  }
);
