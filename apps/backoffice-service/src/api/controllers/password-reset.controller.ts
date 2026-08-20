import type { RequestHandler } from "express";
import { ApiResponse } from "@aimess/utils";

import { getRequestContext } from "../../lib/request-context.js";
import { adminPasswordResetService } from "../../services/index.js";
import type {
  ForgotPasswordInput,
  ResendOtpInput,
  ResetPasswordInput,
  VerifyOtpInput,
} from "../validators/index.js";
import { HTTP_STATUS, t } from "@aimess/constants";

/** POST /v1/auth/forgot-password — enumeration-safe OTP issuance. */
export const forgotPassword: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const { email } = req.body as ForgotPasswordInput;
      await adminPasswordResetService.requestOtp(getRequestContext(req), {
        email,
      });
      res
        .status(HTTP_STATUS.OK)
        .json(new ApiResponse({ email }, t("ADMIN_OTP_SENT", req.locale)));
    } catch (error) {
      next(error);
    }
  })();
};

/** POST /v1/auth/verify-otp — verify OTP, mint a single-use reset token. */
export const verifyOtp: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const { email, code } = req.body as VerifyOtpInput;
      const result = await adminPasswordResetService.verifyOtp({ email, code });
      res
        .status(HTTP_STATUS.OK)
        .json(new ApiResponse(result, t("ADMIN_OTP_VERIFIED", req.locale)));
    } catch (error) {
      next(error);
    }
  })();
};

/** POST /v1/auth/resend-otp — enumeration-safe OTP resend (cooldown applies). */
export const resendOtp: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const { email } = req.body as ResendOtpInput;
      await adminPasswordResetService.resendOtp(getRequestContext(req), {
        email,
      });
      res
        .status(HTTP_STATUS.OK)
        .json(new ApiResponse({ email }, t("ADMIN_OTP_SENT", req.locale)));
    } catch (error) {
      next(error);
    }
  })();
};

/** POST /v1/auth/reset-password — consume reset token, set new password. */
export const resetPassword: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const { resetToken, password } = req.body as ResetPasswordInput;
      await adminPasswordResetService.resetPassword(getRequestContext(req), {
        resetToken,
        password,
      });
      res
        .status(HTTP_STATUS.OK)
        .json(
          new ApiResponse(
            { reset: true },
            t("ADMIN_PASSWORD_RESET_SUCCESS", req.locale)
          )
        );
    } catch (error) {
      next(error);
    }
  })();
};
