import { Router, type IRouter } from "express";

import {
  clearRecentUserSearches,
  recordRecentUserSearch,
  removeRecentUserSearch,
  searchGroups,
  searchUsersUnified,
} from "../controllers/user-search.controller.js";
import { validateBody } from "../middleware/validate-body.js";
import { validateParams } from "../middleware/validate-params.js";
import { validateQuery } from "../middleware/validate-query.js";
import { authenticateAccessToken } from "../../middleware/authenticate-access-token.js";
import {
  groupSearchQuerySchema,
  recordRecentUserSearchSchema,
  removeRecentUserSearchParamsSchema,
  removeRecentUserSearchQuerySchema,
  unifiedSearchQuerySchema,
} from "../validators/user-search.validator.js";

export const userSearchRoutes: IRouter = Router();

userSearchRoutes.use(authenticateAccessToken);

// GET  /api/v1/users/search
userSearchRoutes.get(
  "/",
  validateQuery(unifiedSearchQuerySchema),
  searchUsersUnified
);

// GET  /api/v1/users/search/groups — ACTIVE-membership groups only.
// Declared before the `/recent/...` routes so the literal path wins.
userSearchRoutes.get(
  "/groups",
  validateQuery(groupSearchQuerySchema),
  searchGroups
);

// POST /api/v1/users/search/recent
userSearchRoutes.post(
  "/recent",
  validateBody(recordRecentUserSearchSchema),
  recordRecentUserSearch
);

// DELETE /api/v1/users/search/recent         — clear all
userSearchRoutes.delete("/recent", clearRecentUserSearches);

// DELETE /api/v1/users/search/recent/:targetId?targetType=USER|GROUP — remove one
userSearchRoutes.delete(
  "/recent/:targetId",
  validateParams(removeRecentUserSearchParamsSchema),
  validateQuery(removeRecentUserSearchQuerySchema),
  removeRecentUserSearch
);
