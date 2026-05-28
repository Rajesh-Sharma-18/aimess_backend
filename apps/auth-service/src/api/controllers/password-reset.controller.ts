import type { Request, Response } from "express";

import { HTTP_STATUS, t } from "@aimess/constants";
import { ApiResponse, asyncHandler } from "@aimess/utils";

import type {
  RequestPasswordResetOtpInput,
  ResetPasswordInput,
  VerifyPasswordResetOtpInput,
} from "../validators/password-reset.validator.js";
import { passwordResetService } from "../../services/password-reset.service.js";

export const requestPasswordResetOtp = asyncHandler(
  async (req: Request, res: Response) => {
    const body = req.body as RequestPasswordResetOtpInput;
    await passwordResetService.requestOtp(req, body);

    return res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(
          { email: body.email.trim().toLowerCase() },
          t("AUTH_PASSWORD_RESET_OTP_SENT", req.locale)
        )
      );
  }
);

export const verifyPasswordResetOtp = asyncHandler(
  async (req: Request, res: Response) => {
    const body = req.body as VerifyPasswordResetOtpInput;
    const result = await passwordResetService.verifyOtp(body);

    return res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(
          result,
          t("AUTH_PASSWORD_RESET_OTP_VERIFIED", req.locale)
        )
      );
  }
);

export const resetPassword = asyncHandler(
  async (req: Request, res: Response) => {
    const body = req.body as ResetPasswordInput;
    await passwordResetService.resetPassword(body);

    return res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(null, t("AUTH_PASSWORD_RESET_SUCCESS", req.locale))
      );
  }
);
