import type { Request, Response } from "express";

import { HTTP_STATUS, t } from "@aimess/constants";
import { ApiResponse, asyncHandler } from "@aimess/utils";

import type { SearchUsersQuery } from "../validators/user-discovery.validator.js";
import { userDiscoveryService } from "../../services/user-discovery.service.js";

export const searchUsers = asyncHandler(async (req: Request, res: Response) => {
  const query = req.query as unknown as SearchUsersQuery;

  const result = await userDiscoveryService.searchUsers(req.auth.userId, query);

  return res
    .status(HTTP_STATUS.OK)
    .json(
      new ApiResponse(
        { users: result.users, total: result.total },
        t("USERS_FETCHED", req.locale)
      )
    );
});
