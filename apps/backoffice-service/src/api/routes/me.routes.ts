import { Router, type IRouter } from "express";

import { getMe } from "../controllers/index.js";
import { adminAuth } from "../middleware/index.js";

export const meRoutes: IRouter = Router();

// All self routes require a valid admin bearer.
meRoutes.use(adminAuth);

meRoutes.get("/", getMe);
