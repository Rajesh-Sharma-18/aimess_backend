import type { Request, Response } from "express";

import { HTTP_STATUS, t } from "@aimess/constants";
import { ApiResponse, asyncHandler } from "@aimess/utils";

import type { DeleteAccountInput } from "../validators/account-deletion.validator.js";
import { accountDeletionService } from "../../services/account-deletion.service.js";

export const requestAccountDeletionOtp = asyncHandler(
  async (req: Request, res: Response) => {
    await accountDeletionService.requestDeletionOtp(req, req.auth.userId);

    return res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(null, t("AUTH_ACCOUNT_DELETE_OTP_SENT", req.locale))
      );
  }
);

export const deleteAccount = asyncHandler(
  async (req: Request, res: Response) => {
    const body = req.body as DeleteAccountInput;
    const result = await accountDeletionService.deleteAccount(
      req,
      req.auth.userId,
      body
    );

    return res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(result, t("AUTH_ACCOUNT_DELETED", req.locale)));
  }
);
