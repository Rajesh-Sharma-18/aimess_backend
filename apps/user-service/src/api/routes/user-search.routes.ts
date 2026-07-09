import { Router, type IRouter } from "express";

import {
  recordRecentUserSearch,
  searchUsersUnified,
} from "../controllers/user-search.controller.js";
import { validateBody } from "../middleware/validate-body.js";
import { validateQuery } from "../middleware/validate-query.js";
import { authenticateAccessToken } from "../../middleware/authenticate-access-token.js";
import {
  recordRecentUserSearchSchema,
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
