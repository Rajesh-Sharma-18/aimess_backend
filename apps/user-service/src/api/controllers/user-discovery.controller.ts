import type { Request, Response } from "express";

import { HTTP_STATUS, t } from "@aimess/constants";
import { ApiResponse, asyncHandler } from "@aimess/utils";

import type { SearchUsersQuery } from "../validators/user-discovery.validator.js";
import { userDiscoveryService } from "../../services/user-discovery.service.js";

export const searchUsers = asyncHandler(async (req: Request, res: Response) => {
  const query = req.query as unknown as SearchUsersQuery;
  const { q, type, page, limit, excludeGroupRoomId, excludeCommunityId } =
    query;

  // "Add Members" pickers pass the target conversation; everyone already in it
  // is subtracted server-side so the picker can never offer them (issue #48).
  const excludeUserIds = await userDiscoveryService.resolveExistingMemberIds({
    groupRoomId: excludeGroupRoomId,
    communityId: excludeCommunityId,
  });

  // Paginated mode: type=friends or type=others
  if (type === "friends" || type === "others") {
    const skip = (page - 1) * limit;
    const result =
      type === "friends"
        ? await userDiscoveryService._queryFriends(
            req.auth.userId,
            q,
            skip,
            limit,
            excludeUserIds
          )
        : await userDiscoveryService._queryOthers(
            req.auth.userId,
            q,
            skip,
            limit,
            excludeUserIds
          );
    const totalPages = Math.ceil(result.total / limit);
    return res.status(HTTP_STATUS.OK).json(
      new ApiResponse(
        {
          users: result.users,
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
    q,
    excludeUserIds
  );
  return res
    .status(HTTP_STATUS.OK)
    .json(
      new ApiResponse(
        { friends: result.friends, otherPeople: result.otherPeople },
        t("USERS_FETCHED", req.locale)
      )
    );
});
