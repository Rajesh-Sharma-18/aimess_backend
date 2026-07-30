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
import { friendshipRepository } from "../../repositories/friendship.repository.js";
import { buildFriendshipView } from "../../lib/friendship-view.js";

type FriendshipRow = Parameters<typeof buildFriendshipView>[1];

/**
 * Every friendship-mutating endpoint returns the same shape: the raw
 * persisted row PLUS the viewer-derived view (status/direction/canAccept/
 * canReject/canCancel) — one helper, so no endpoint hand-rolls this.
 */
function withView(row: FriendshipRow, viewerId: string) {
  return { ...row, ...buildFriendshipView(viewerId, row) };
}

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
      .json(
        new ApiResponse(
          withView(friendship, req.auth.userId),
          t("FRIEND_REQUEST_SENT", req.locale)
        )
      );
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
        new ApiResponse(
          withView(friendship, req.auth.userId),
          t("FRIEND_REQUEST_ACCEPTED", req.locale)
        )
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
        new ApiResponse(
          withView(friendship, req.auth.userId),
          t("FRIEND_REQUEST_REJECTED", req.locale)
        )
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
        new ApiResponse(
          withView(friendship, req.auth.userId),
          t("FRIEND_REQUEST_CANCELLED", req.locale)
        )
      );
  }
);

export const getBlockedUsers = asyncHandler(
  async (req: Request, res: Response) => {
    const blocked = await friendshipService.getBlockedUsers(req.auth.userId);

    return res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(blocked, t("USER_BLOCKED_LIST_FETCHED", req.locale))
      );
  }
);

export const blockUser = asyncHandler(async (req: Request, res: Response) => {
  const { userId } = req.params as unknown as UnfriendParams;

  await friendshipService.blockUser(req.auth.userId, userId);

  return res
    .status(HTTP_STATUS.OK)
    .json(new ApiResponse(undefined, t("FRIEND_USER_BLOCKED", req.locale)));
});

export const unblockUser = asyncHandler(async (req: Request, res: Response) => {
  const { userId } = req.params as unknown as UnfriendParams;

  await friendshipService.unblockUser(req.auth.userId, userId);

  return res
    .status(HTTP_STATUS.OK)
    .json(new ApiResponse(undefined, t("FRIEND_USER_UNBLOCKED", req.locale)));
});

export const getFriendshipStatus = asyncHandler(
  async (req: Request, res: Response) => {
    const { userId } = req.params as unknown as UnfriendParams;
    const viewerId = req.auth.userId;

    const [row, block] = await Promise.all([
      friendshipRepository.findByPair(viewerId, userId),
      friendshipRepository.findBlock(viewerId, userId),
    ]);

    const view = buildFriendshipView(viewerId, row, block !== null);

    return res
      .status(HTTP_STATUS.OK)
      .json(
        new ApiResponse(
          { friendshipId: row?.id ?? null, ...view },
          t("USER_FRIENDSHIP_STATUS_FETCHED", req.locale)
        )
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
