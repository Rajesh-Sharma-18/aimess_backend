import { Router, type IRouter } from "express";

import { searchUsers } from "../controllers/user-discovery.controller.js";
import {
  getPeerIdentities,
  getPublicProfile,
  getPublicProfileByUsername,
} from "../controllers/profile.controller.js";
import { validateBody } from "../middleware/validate-body.js";
import { validateParams } from "../middleware/validate-params.js";
import { validateQuery } from "../middleware/validate-query.js";
import { authenticateAccessToken } from "../../middleware/authenticate-access-token.js";
import {
  publicProfileByUsernameParamsSchema,
  publicProfileParamsSchema,
  publicProfileQuerySchema,
} from "../validators/profile.validator.js";
import { searchUsersQuerySchema } from "../validators/user-discovery.validator.js";
import { relationshipsBatchSchema } from "../validators/friendship.validator.js";

export const usersRoutes: IRouter = Router();

usersRoutes.post(
  "/identities",
  authenticateAccessToken,
  validateBody(relationshipsBatchSchema),
  getPeerIdentities
);

usersRoutes.get(
  "/",
  authenticateAccessToken,
  validateQuery(searchUsersQuerySchema),
  searchUsers
);

usersRoutes.get(
  "/by-username/:username",
  authenticateAccessToken,
  validateParams(publicProfileByUsernameParamsSchema),
  getPublicProfileByUsername
);

// Registered LAST and only on this router, which itself mounts last at "/" —
// so `:userId` can never shadow /search, /friends, /profiles, /settings,
// /usernames, /accounts or /recent-searches.
usersRoutes.get(
  "/:userId",
  authenticateAccessToken,
  validateParams(publicProfileParamsSchema),
  validateQuery(publicProfileQuerySchema),
  getPublicProfile
);
