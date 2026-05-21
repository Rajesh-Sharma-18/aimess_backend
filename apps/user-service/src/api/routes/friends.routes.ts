import { Router, type IRouter } from "express";

import { listFriends } from "../controllers/friends.controller.js";
import { validateQuery } from "../middleware/validate-query.js";
import { authenticateAccessToken } from "../../middleware/authenticate-access-token.js";
import { listFriendsQuerySchema } from "../validators/friends.validator.js";

export const friendsRoutes: IRouter = Router();

friendsRoutes.get(
  "/",
  authenticateAccessToken,
  validateQuery(listFriendsQuerySchema),
  listFriends
);
