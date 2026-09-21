import type { Request, Response } from "express";

import { HTTP_STATUS, t } from "@aimess/constants";
import { ApiResponse, asyncHandler } from "@aimess/utils";

import type { SearchUsersQuery } from "../validators/user-discovery.validator.js";
import {
  userDiscoveryService,
  type UserDiscoveryResult,
} from "../../services/user-discovery.service.js";

export const searchUsers = asyncHandler(async (req: Request, res: Response) => {
  const query = req.query as unknown as SearchUsersQuery;
  const {
    q,
    type,
    page,
    limit,
    groupRoomId,
    communityId,
  } = query;

  // Pickers keep existing members in the list but disabled, so tag rather than drop.
  const memberIds = new Set(
    await userDiscoveryService.resolveExistingMemberIds({
      groupRoomId,
      communityId,
    })
  );
  const withIsMember = (users: UserDiscoveryResult[]) =>
    users.map((user) => ({ ...user, isMember: memberIds.has(user.userId) }));

  // Paginated mode: type=friends or type=others
  if (type === "friends" || type === "others") {
    const skip = (page - 1) * limit;
    const result =
      type === "friends"
        ? await userDiscoveryService._queryFriends(
            req.auth.userId,
            q,
            skip,
            limit
          )
        : await userDiscoveryService._queryOthers(
            req.auth.userId,
            q,
            skip,
            limit
          );
    const totalPages = Math.ceil(result.total / limit);
    return res.status(HTTP_STATUS.OK).json(
      new ApiResponse(
        {
          users: withIsMember(result.users),
          pagination: {
            total: result.total,
            page,
            limit,
            totalPages,
            hasNext: page < totalPages,
            hasPrevious: page > 1,
          },
        },
        t("USERS_FETCHED", req.locale)
      )
    );
  }

  // Split mode (no type): max 5 per group, no pagination
  const result = await userDiscoveryService.searchUsersSplit(
    req.auth.userId,
    q
  );
  return res
    .status(HTTP_STATUS.OK)
    .json(
      new ApiResponse(
        {
          friends: withIsMember(result.friends),
          otherPeople: withIsMember(result.otherPeople),
        },
        t("USERS_FETCHED", req.locale)
      )
    );
});
