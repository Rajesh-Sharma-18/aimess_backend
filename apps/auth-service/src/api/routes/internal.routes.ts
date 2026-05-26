import { Router, type IRouter } from "express";

import { getAccountsByUserIds } from "../controllers/internal.controller.js";

export const internalRoutes: IRouter = Router();

// GET /api/internal/accounts?userIds=uuid1,uuid2,...
internalRoutes.get("/accounts", getAccountsByUserIds);
