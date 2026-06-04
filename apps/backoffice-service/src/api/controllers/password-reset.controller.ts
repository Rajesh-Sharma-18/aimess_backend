import type { RequestHandler } from "express";

import { getRequestContext } from "../../lib/request-context.js";
import { adminPasswordResetService } from "../../services/index.js";
import type {
  ForgotPasswordInput,
  ResendOtpInput,
  ResetPasswordInput,
  VerifyOtpInput,
} from "../validators/index.js";

const NEUTRAL_OTP_MESSAGE = "If an account exists, an OTP has been sent.";

/** POST /v1/auth/forgot-password — enumeration-safe OTP issuance. */
export const forgotPassword: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const { email } = req.body as ForgotPasswordInput;
      await adminPasswordResetService.requestOtp(getRequestContext(req), {
        email,
      });
      res.status(200).json({
        success: true,
        message: NEUTRAL_OTP_MESSAGE,
        data: { email },
      });
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
      res.status(200).json({
        success: true,
        message: "OTP verified.",
        data: result,
      });
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
      res.status(200).json({
        success: true,
        message: NEUTRAL_OTP_MESSAGE,
        data: { email },
      });
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
      res.status(200).json({
        success: true,
        message: "Password updated successfully.",
        data: { reset: true },
      });
    } catch (error) {
      next(error);
    }
  })();
};
