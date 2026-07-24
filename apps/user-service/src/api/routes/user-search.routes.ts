import { Router, type IRouter } from "express";

import {
  clearRecentUserSearches,
  recordRecentUserSearch,
  removeRecentUserSearch,
  searchUsersUnified,
} from "../controllers/user-search.controller.js";
import { validateBody } from "../middleware/validate-body.js";
import { validateParams } from "../middleware/validate-params.js";
import { validateQuery } from "../middleware/validate-query.js";
import { authenticateAccessToken } from "../../middleware/authenticate-access-token.js";
import {
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
