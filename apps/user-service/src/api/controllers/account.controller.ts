import type { Request, Response } from "express";

import { HTTP_STATUS, t } from "@aimess/constants";
import { ApiResponse, asyncHandler } from "@aimess/utils";

import { connectedAccountsService } from "../../services/connected-accounts.service.js";

export const getMyAccount = asyncHandler(
  async (req: Request, res: Response) => {
    const account = await connectedAccountsService.getConnectedAccounts(
      req.auth.userId
    );

    return res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(
          account,
          t("USER_CONNECTED_ACCOUNTS_FETCHED", req.locale)
        )
      );
  }
);
