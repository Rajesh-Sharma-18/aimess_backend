import { Router, type IRouter } from "express";
import { getBulkSnapshot } from "../controllers/internal.controller.js";

export const internalRoutes: IRouter = Router();
internalRoutes.get("/bulk-snapshot", getBulkSnapshot);
