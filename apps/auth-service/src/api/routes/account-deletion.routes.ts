import { Router, type IRouter } from "express";

import { deleteAccount } from "../controllers/account-deletion.controller.js";
import { validateBody } from "../middleware/validate-body.js";
import { authenticateAccessToken } from "../../middleware/authenticate-access-token.js";
import { deleteAccountRateLimiter } from "../../middleware/rate-limiters.js";
import { deleteAccountSchema } from "../validators/account-deletion.validator.js";

export const accountDeletionRoutes: IRouter = Router();

accountDeletionRoutes.delete(
  "/account",
  authenticateAccessToken,
  // After auth so the limiter keys on userId, not a shared NAT IP.
  deleteAccountRateLimiter,
  validateBody(deleteAccountSchema),
  deleteAccount
);
