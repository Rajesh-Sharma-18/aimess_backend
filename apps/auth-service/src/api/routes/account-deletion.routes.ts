import { Router, type IRouter } from "express";

import { deleteAccount } from "../controllers/account-deletion.controller.js";

export const accountDeletionRoutes: IRouter = Router();

accountDeletionRoutes.delete("/account", deleteAccount);
