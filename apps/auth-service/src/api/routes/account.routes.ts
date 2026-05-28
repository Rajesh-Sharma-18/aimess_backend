import { Router, type IRouter } from "express";

import { getMyAccount } from "../controllers/account.controller.js";
import { authenticateAccessToken } from "../../middleware/authenticate-access-token.js";

export const accountRoutes: IRouter = Router();

/** Service-to-service only (user-service). Not exposed on the public API gateway. */
accountRoutes.get("/internal/account", authenticateAccessToken, getMyAccount);
