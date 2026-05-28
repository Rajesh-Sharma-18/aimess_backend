import type { Request, Response } from "express";
import { HTTP_STATUS } from "@aimess/constants";
import { ApiResponse, asyncHandler } from "@aimess/utils";
import { buildDisplayName } from "../../lib/profile-fields.util.js";
import { friendshipRepository } from "../../repositories/friendship.repository.js";
import { userProfileRepository } from "../../repositories/user-profile.repository.js";

export const getBulkSnapshot = asyncHandler(
  async (req: Request, res: Response) => {
    const raw = req.query["userIds"];
    const userIds =
      typeof raw === "string" && raw.length > 0
        ? raw.split(",").slice(0, 500)
        : [];

    if (userIds.length === 0) {
      return res
        .status(HTTP_STATUS.OK)
        .json(new ApiResponse({ users: [] }, "ok"));
    }

    const profiles = await userProfileRepository.findManyByUserIds(userIds);
    const users = profiles.map((p) => ({
      userId: p.userId,
      username: p.username,
      displayName: buildDisplayName(p.firstName, p.lastName),
      avatarObjectKey: p.avatarUrl ?? null,
    }));

    return res.status(HTTP_STATUS.OK).json(new ApiResponse({ users }, "ok"));
  }
);

export const getFriendshipCheck = asyncHandler(
  async (req: Request, res: Response) => {
    const callerRaw = req.query["callerId"];
    const candidatesRaw = req.query["candidateIds"];

    const callerId =
      typeof callerRaw === "string" && callerRaw.length > 0 ? callerRaw : null;
    const candidateIds =
      typeof candidatesRaw === "string" && candidatesRaw.length > 0
        ? candidatesRaw.split(",").slice(0, 500)
        : [];

    if (!callerId || candidateIds.length === 0) {
      return res
        .status(HTTP_STATUS.OK)
        .json(new ApiResponse({ friends: [] }, "ok"));
    }

    const friends = await friendshipRepository.findAcceptedFriendIdsForUser(
      callerId,
      candidateIds
    );

    return res.status(HTTP_STATUS.OK).json(new ApiResponse({ friends }, "ok"));
  }
);
