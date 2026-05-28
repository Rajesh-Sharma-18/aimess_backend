import type { Request, Response } from "express";

import { HTTP_STATUS, t } from "@aimess/constants";
import { ApiResponse, asyncHandler } from "@aimess/utils";

import { accountDeletionService } from "../../services/account-deletion.service.js";

export const deleteAccount = asyncHandler(
  async (req: Request, res: Response) => {
    const { email } = req.body as { email: string };
    const result = await accountDeletionService.deleteAccount(email);

    return res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(result, t("AUTH_ACCOUNT_DELETED", req.locale)));
  }
);
