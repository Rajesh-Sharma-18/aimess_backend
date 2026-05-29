import type { Request, Response } from "express";

import { HTTP_STATUS, t } from "@aimess/constants";
import { ApiResponse, asyncHandler } from "@aimess/utils";

import type { DeleteAccountInput } from "../validators/account-deletion.validator.js";
import { accountDeletionService } from "../../services/account-deletion.service.js";

export const deleteAccount = asyncHandler(
  async (req: Request, res: Response) => {
    const { password } = req.body as DeleteAccountInput;
    const result = await accountDeletionService.deleteAccount(
      req.auth.userId,
      password
    );

    return res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(result, t("AUTH_ACCOUNT_DELETED", req.locale)));
  }
);
