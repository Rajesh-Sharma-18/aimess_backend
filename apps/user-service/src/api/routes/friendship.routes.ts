import { Router, type IRouter } from "express";

import {
  acceptFriendRequest,
  autoDisconnectFriends,
  blockUser,
  cancelFriendRequest,
  getBlockedUsers,
  getFriendshipStatus,
  listFriendRequests,
  makeUsersFriends,
  rejectFriendRequest,
  sendFriendRequest,
  unblockUser,
  unfriend,
} from "../controllers/friendship.controller.js";
import { validateBody } from "../middleware/validate-body.js";
import { validateParams } from "../middleware/validate-params.js";
import { validateQuery } from "../middleware/validate-query.js";
import { authenticateAccessToken } from "../../middleware/authenticate-access-token.js";
import {
  friendshipIdParamsSchema,
  listFriendRequestsQuerySchema,
  sendFriendRequestSchema,
  unfriendParamsSchema,
} from "../validators/friendship.validator.js";

export const friendshipRoutes: IRouter = Router();

friendshipRoutes.get(
  "/requests",
  authenticateAccessToken,
  validateQuery(listFriendRequestsQuerySchema),
  listFriendRequests
);

friendshipRoutes.post(
  "/requests",
  authenticateAccessToken,
  validateBody(sendFriendRequestSchema),
  sendFriendRequest
);

friendshipRoutes.post(
  "/requests/:id/accept",
  authenticateAccessToken,
  validateParams(friendshipIdParamsSchema),
  acceptFriendRequest
);

friendshipRoutes.post(
  "/requests/:id/reject",
  authenticateAccessToken,
  validateParams(friendshipIdParamsSchema),
  rejectFriendRequest
);

friendshipRoutes.delete(
  "/requests/:id",
  authenticateAccessToken,
  validateParams(friendshipIdParamsSchema),
  cancelFriendRequest
);

friendshipRoutes.post(
  "/auto-connect",
  authenticateAccessToken,
  makeUsersFriends
);

friendshipRoutes.post(
  "/auto-disconnect",
  authenticateAccessToken,
  autoDisconnectFriends
);

friendshipRoutes.get(
  "/status/:userId",
  authenticateAccessToken,
  validateParams(unfriendParamsSchema),
  getFriendshipStatus
);

friendshipRoutes.get("/blocked", authenticateAccessToken, getBlockedUsers);

friendshipRoutes.post(
  "/block/:userId",
  authenticateAccessToken,
  validateParams(unfriendParamsSchema),
  blockUser
);

friendshipRoutes.delete(
  "/block/:userId",
  authenticateAccessToken,
  validateParams(unfriendParamsSchema),
  unblockUser
);

friendshipRoutes.delete(
  "/:userId",
  authenticateAccessToken,
  validateParams(unfriendParamsSchema),
  unfriend
);
