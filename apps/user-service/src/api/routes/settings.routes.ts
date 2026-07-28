import { Router, type IRouter } from "express";

import {
  getMySettings,
  updateMySettings,
  listCallAllowedFriends,
  addCallAllowedFriend,
  removeCallAllowedFriend,
} from "../controllers/settings.controller.js";
import { validateBody } from "../middleware/validate-body.js";
import { validateParams } from "../middleware/validate-params.js";
import { validateQuery } from "../middleware/validate-query.js";
import { authenticateAccessToken } from "../../middleware/authenticate-access-token.js";
import {
  updateSettingsSchema,
  friendIdParamSchema,
  listCallAllowedFriendsQuerySchema,
} from "../validators/settings.validator.js";

export const settingsRoutes: IRouter = Router();

settingsRoutes.get("/me", authenticateAccessToken, getMySettings);

settingsRoutes.patch(
  "/me",
  authenticateAccessToken,
  validateBody(updateSettingsSchema),
  updateMySettings
);

settingsRoutes.get(
  "/call-allowed-friends",
  authenticateAccessToken,
  validateQuery(listCallAllowedFriendsQuerySchema),
  listCallAllowedFriends
);

settingsRoutes.put(
  "/call-allowed-friends/:friendId",
  authenticateAccessToken,
  validateParams(friendIdParamSchema),
  addCallAllowedFriend
);

settingsRoutes.delete(
  "/call-allowed-friends/:friendId",
  authenticateAccessToken,
  validateParams(friendIdParamSchema),
  removeCallAllowedFriend
);
