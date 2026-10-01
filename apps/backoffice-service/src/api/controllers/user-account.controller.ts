import { HTTP_STATUS, t } from "@aimess/constants";
import { ApiResponse } from "@aimess/utils";
import type { RequestHandler } from "express";

import { getRequestContext } from "../../lib/request-context.js";
import { userAccountService } from "../../services/index.js";
import type {
  UpdateUserAccountInput,
  UserSocialProviderParam,
} from "../validators/index.js";

export const getUserAccount: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const result = await userAccountService.getAccount(
        req.params.userId as string
      );
      res.status(HTTP_STATUS.OK).json(new ApiResponse(result));
    } catch (error) {
      next(error);
    }
  })();
};

export const updateUserAccount: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const result = await userAccountService.updateAccount(
        req.params.userId as string,
        req.body as UpdateUserAccountInput,
        req.admin!,
        getRequestContext(req)
      );
      res
        .status(HTTP_STATUS.OK)
        .json(new ApiResponse(result, t("ADMIN_USER_UPDATED", req.locale)));
    } catch (error) {
      next(error);
    }
  })();
};

export const unlinkUserSocialAccount: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const { userId, provider } =
        req.params as unknown as UserSocialProviderParam;
      const result = await userAccountService.unlinkSocialAccount(
        userId,
        provider,
        req.admin!,
        getRequestContext(req)
      );
      res
        .status(HTTP_STATUS.OK)
        .json(
          new ApiResponse(result, t("ADMIN_USER_SOCIAL_UNLINKED", req.locale))
        );
    } catch (error) {
      next(error);
    }
  })();
};
