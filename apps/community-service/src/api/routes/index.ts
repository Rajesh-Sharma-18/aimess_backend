import { Router, type IRouter } from "express";

import { communityRoutes } from "./community.routes.js";
import { communityV2Routes } from "./community-v2.routes.js";

/** API v1 routes — mounted at `/api/v1`. */
export const serviceRoutes: IRouter = Router();

serviceRoutes.use("/communities", communityRoutes);

/** API v2 routes — mounted at `/api/v2`. Additive; V1 above is untouched. */
export const serviceV2Routes: IRouter = Router();

serviceV2Routes.use("/communities", communityV2Routes);
