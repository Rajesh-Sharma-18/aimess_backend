import { Router, type IRouter } from "express";

import { getMyAccount } from "../controllers/account.controller.js";
import { authenticateAccessToken } from "../../middleware/authenticate-access-token.js";

export const accountRoutes: IRouter = Router();

accountRoutes.get("/me", authenticateAccessToken, getMyAccount);
