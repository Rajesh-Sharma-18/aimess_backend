import type { Request, Response } from "express";

import { HTTP_STATUS, t } from "@aimess/constants";
import { ApiResponse, asyncHandler } from "@aimess/utils";

import type {
  FriendshipIdParams,
  SendFriendRequestInput,
  UnfriendParams,
} from "../validators/friendship.validator.js";
import { friendshipService } from "../../services/friendship.service.js";

export const sendFriendRequest = asyncHandler(
  async (req: Request, res: Response) => {
    const { addresseeId } = req.body as SendFriendRequestInput;

    const friendship = await friendshipService.sendRequest(
      req.auth.userId,
      addresseeId
    );
    return res
      .status(HTTP_STATUS.CREATED)
      .json(new ApiResponse(friendship, t("FRIEND_REQUEST_SENT", req.locale)));
  }
);

export const acceptFriendRequest = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params as unknown as FriendshipIdParams;

    const friendship = await friendshipService.acceptRequest(
      id,
      req.auth.userId
    );

    return res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(friendship, t("FRIEND_REQUEST_ACCEPTED", req.locale))
      );
  }
);

export const rejectFriendRequest = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params as unknown as FriendshipIdParams;

    const friendship = await friendshipService.rejectRequest(
      id,
      req.auth.userId
    );

    return res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(friendship, t("FRIEND_REQUEST_REJECTED", req.locale))
      );
  }
);

export const cancelFriendRequest = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params as unknown as FriendshipIdParams;

    const friendship = await friendshipService.cancelRequest(
      id,
      req.auth.userId
    );

    return res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(friendship, t("FRIEND_REQUEST_CANCELLED", req.locale))
      );
  }
);

export const unfriend = asyncHandler(async (req: Request, res: Response) => {
  const { userId } = req.params as unknown as UnfriendParams;

  await friendshipService.unfriend(req.auth.userId, userId);

  return res
    .status(HTTP_STATUS.OK)
    .json(new ApiResponse(undefined, t("FRIEND_REMOVED", req.locale)));
});
