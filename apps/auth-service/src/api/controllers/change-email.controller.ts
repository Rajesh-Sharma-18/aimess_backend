import type { Request, Response } from "express";

import { HTTP_STATUS, t } from "@aimess/constants";
import { ApiResponse, asyncHandler } from "@aimess/utils";

import type {
  RequestChangeEmailInput,
  VerifyChangeEmailInput,
} from "../validators/change-email.validator.js";
import { changeEmailService } from "../../services/change-email.service.js";

export const requestChangeEmailOtp = asyncHandler(
  async (req: Request, res: Response) => {
    const body = req.body as RequestChangeEmailInput;
    await changeEmailService.requestOtp(req, req.auth.userId, body);

    return res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(null, t("AUTH_CHANGE_EMAIL_OTP_SENT", req.locale)));
  }
);

export const verifyChangeEmailOtp = asyncHandler(
  async (req: Request, res: Response) => {
    const body = req.body as VerifyChangeEmailInput;
    const result = await changeEmailService.verifyAndChange(
      req.auth.userId,
      body
    );

    return res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(result, t("AUTH_CHANGE_EMAIL_SUCCESS", req.locale))
      );
  }
);
