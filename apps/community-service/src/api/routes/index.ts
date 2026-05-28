import { Router, type IRouter } from "express";

import { communityRoutes } from "./community.routes.js";

/** API v1 routes — mounted at `/api/v1`. */
export const serviceRoutes: IRouter = Router();

serviceRoutes.use("/communities", communityRoutes);
