import { Router, type IRouter } from "express";

import {
  deleteAccount,
  requestAccountDeletionOtp,
} from "../controllers/account-deletion.controller.js";
import { validateBody } from "../middleware/validate-body.js";
import { authenticateAccessToken } from "../../middleware/authenticate-access-token.js";
import { deleteAccountSchema } from "../validators/account-deletion.validator.js";

export const accountDeletionRoutes: IRouter = Router();

accountDeletionRoutes.post(
  "/account/delete/request-otp",
  authenticateAccessToken,
  requestAccountDeletionOtp
);

accountDeletionRoutes.delete(
  "/account",
  authenticateAccessToken,
  validateBody(deleteAccountSchema),
  deleteAccount
);
