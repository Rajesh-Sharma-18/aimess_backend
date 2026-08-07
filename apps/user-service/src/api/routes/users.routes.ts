import { Router, type IRouter } from "express";

import { searchUsers } from "../controllers/user-discovery.controller.js";
import { getPublicProfile } from "../controllers/profile.controller.js";
import { validateParams } from "../middleware/validate-params.js";
import { validateQuery } from "../middleware/validate-query.js";
import { authenticateAccessToken } from "../../middleware/authenticate-access-token.js";
import { publicProfileParamsSchema } from "../validators/profile.validator.js";
import { searchUsersQuerySchema } from "../validators/user-discovery.validator.js";

export const usersRoutes: IRouter = Router();

usersRoutes.get(
  "/",
  authenticateAccessToken,
  validateQuery(searchUsersQuerySchema),
  searchUsers
);

// Registered LAST and only on this router, which itself mounts last at "/" —
// so `:userId` can never shadow /search, /friends, /profiles, /settings,
// /usernames, /accounts or /recent-searches.
usersRoutes.get(
  "/:userId",
  authenticateAccessToken,
  validateParams(publicProfileParamsSchema),
  getPublicProfile
);
