import type { Request, Response } from "express";

import { HTTP_STATUS, t } from "@aimess/constants";
import { ApiResponse, asyncHandler } from "@aimess/utils";

import type { ChangePasswordInput } from "../validators/change-password.validator.js";
import { changePasswordService } from "../../services/change-password.service.js";

export const changePassword = asyncHandler(
  async (req: Request, res: Response) => {
    const body = req.body as ChangePasswordInput;
    await changePasswordService.change(req.auth.userId, body);

    return res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(null, t("AUTH_CHANGE_PASSWORD_SUCCESS", req.locale))
      );
  }
);
