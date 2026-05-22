import { Router, type IRouter } from "express";

import {
  acceptFriendRequest,
  cancelFriendRequest,
  rejectFriendRequest,
  sendFriendRequest,
  unfriend,
} from "../controllers/friendship.controller.js";
import { validateBody } from "../middleware/validate-body.js";
import { validateParams } from "../middleware/validate-params.js";
import { authenticateAccessToken } from "../../middleware/authenticate-access-token.js";
import {
  friendshipIdParamsSchema,
  sendFriendRequestSchema,
  unfriendParamsSchema,
} from "../validators/friendship.validator.js";

export const friendshipRoutes: IRouter = Router();

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

friendshipRoutes.delete(
  "/:userId",
  authenticateAccessToken,
  validateParams(unfriendParamsSchema),
  unfriend
);
