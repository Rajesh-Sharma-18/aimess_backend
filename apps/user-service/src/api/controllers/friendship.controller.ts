import type { Request, Response } from "express";

import { HTTP_STATUS, t } from "@aimess/constants";
import { ApiResponse, asyncHandler } from "@aimess/utils";

import type {
  FriendshipIdParams,
  ListFriendRequestsQuery,
  SendFriendRequestInput,
  UnfriendParams,
} from "../validators/friendship.validator.js";
import { friendshipService } from "../../services/friendship.service.js";

export const listFriendRequests = asyncHandler(
  async (req: Request, res: Response) => {
    const query = req.query as unknown as ListFriendRequestsQuery;

    const result = await friendshipService.listRequests(req.auth.userId, query);

    return res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(result, t("USER_FRIEND_REQUESTS_FETCHED", req.locale))
      );
  }
);

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

export const makeUsersFriends = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const result = await friendshipService.autoConnectAll(req.auth.userId);
    res
      .status(HTTP_STATUS.OK)
      .json(new ApiResponse(result, t("FRIENDS_AUTO_CONNECTED", req.locale)));
  }
);

export const autoDisconnectFriends = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const result = await friendshipService.autoDisconnectAll(req.auth.userId);
    res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(result, t("FRIENDS_AUTO_DISCONNECTED", req.locale))
      );
  }
);
