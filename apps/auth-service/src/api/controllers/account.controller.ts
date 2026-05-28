import type { Request, Response } from "express";

import { HTTP_STATUS, t } from "@aimess/constants";
import { ApiResponse, asyncHandler } from "@aimess/utils";

import { accountService } from "../../services/account.service.js";

export const getMyAccount = asyncHandler(
  async (req: Request, res: Response) => {
    const summary = await accountService.getAccountSummary(req.auth.userId);

    return res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(summary, t("AUTH_ACCOUNT_FETCHED", req.locale)));
  }
);
