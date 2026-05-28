import type { Request, Response } from "express";

import { HTTP_STATUS, t } from "@aimess/constants";
import { ApiResponse, asyncHandler } from "@aimess/utils";

import type { ListFriendsQuery } from "../validators/friends.validator.js";
import { friendsService } from "../../services/friends.service.js";

export const listFriends = asyncHandler(async (req: Request, res: Response) => {
  const { search, cursor, limit } = req.query as unknown as ListFriendsQuery;

  const result = await friendsService.listFriends(req.auth.userId, {
    search,
    cursor,
    limit,
  });

  return res
    .status(HTTP_STATUS.OK)
    .json(new ApiResponse(result, t("USER_FRIENDS_FETCHED", req.locale)));
});
