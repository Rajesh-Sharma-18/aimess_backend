import type { Request, Response } from "express";

import { HTTP_STATUS, t } from "@aimess/constants";
import { ApiResponse, asyncHandler } from "@aimess/utils";

import type {
  LoginInput,
  RegisterInput,
  ValidateAccountInput,
} from "../validators/auth.validator.js";
import { accountAvailabilityService } from "../../services/account-availability.service.js";
import { authService } from "../../services/auth.service.js";

export const validateAccount = asyncHandler(
  async (req: Request, res: Response) => {
    const { account } = req.body as ValidateAccountInput;
    const result =
      await accountAvailabilityService.validateAvailability(account);

    return res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(result, t("AUTH_ACCOUNT_VALIDATED", req.locale)));
  }
);

export const register = asyncHandler(async (req: Request, res: Response) => {
  const body = req.body as RegisterInput;
  const result = await authService.register(req, body);

  return res
    .status(HTTP_STATUS.CREATED)
    .json(new ApiResponse(result, t("AUTH_REGISTRATION_SUCCESS", req.locale)));
});

export const login = asyncHandler(async (req: Request, res: Response) => {
  const body = req.body as LoginInput;
  const result = await authService.login(req, body);

  return res
    .status(HTTP_STATUS.OK)
    .json(new ApiResponse(result, t("AUTH_LOGIN_SUCCESS", req.locale)));
});
