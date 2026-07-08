import { Router, type IRouter } from "express";

import {
  listRecentSearches,
  recordRecentSearch,
  deleteRecentSearch,
  clearRecentSearches,
} from "../controllers/recent-search.controller.js";
import { validateBody } from "../middleware/validate-body.js";
import { authenticateAccessToken } from "../../middleware/authenticate-access-token.js";
import { recordRecentSearchSchema } from "../validators/recent-search.validator.js";

export const recentSearchesRoutes: IRouter = Router();

recentSearchesRoutes.use(authenticateAccessToken);

// GET  /api/v1/users/recent-searches
recentSearchesRoutes.get("/", listRecentSearches);

// POST /api/v1/users/recent-searches
recentSearchesRoutes.post(
  "/",
  validateBody(recordRecentSearchSchema),
  recordRecentSearch
);

// DELETE /api/v1/users/recent-searches       — clear all
recentSearchesRoutes.delete("/", clearRecentSearches);

// DELETE /api/v1/users/recent-searches/:id   — remove one
recentSearchesRoutes.delete("/:id", deleteRecentSearch);
