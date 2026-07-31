import type { Request, Response } from "express";

import { HTTP_STATUS, t } from "@aimess/constants";
import { ApiResponse, asyncHandler } from "@aimess/utils";

import type {
  GenerateUsernameInput,
  ValidateUsernameInput,
  ValidateUsernameQuery,
} from "../validators/username.validator.js";
import { usernameService } from "../../services/username.service.js";

export const generateUsername = asyncHandler(
  async (req: Request, res: Response) => {
    const { account } = req.body as GenerateUsernameInput;
    const result = await usernameService.generateFromAccount(account);

    return res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(result, t("USER_USERNAME_GENERATED", req.locale)));
  }
);

export const validateUsername = asyncHandler(
  async (req: Request, res: Response) => {
    const { username } = req.body as ValidateUsernameInput;
    const excludeUserId = req.auth.userId;

    const result = await usernameService.validateAvailability(
      username,
      excludeUserId
    );

    const messageKey = result.available
      ? "USER_USERNAME_AVAILABLE"
      : "USER_USERNAME_TAKEN";

    return res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(result, t(messageKey, req.locale)));
  }
);

/** GET variant used by the FE availability check (register + profile-edit screens). */
export const validateUsernameQuery = asyncHandler(
  async (req: Request, res: Response) => {
    const { username } = req.query as unknown as ValidateUsernameQuery;
    const excludeUserId = req.auth.userId;

    const result = await usernameService.validateAvailability(
      username,
      excludeUserId
    );

    const messageKey = result.available
      ? "USER_USERNAME_AVAILABLE"
      : "USER_USERNAME_TAKEN";

    return res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(result, t(messageKey, req.locale)));
  }
);
