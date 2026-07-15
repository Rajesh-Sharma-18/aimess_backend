import { Router, type IRouter } from "express";

import { authenticateAccessToken } from "../../middleware/authenticate-access-token.js";
import { validateQuery } from "../middleware/validate-query.js";
import { myCommunitiesV2QuerySchema } from "../validators/community.validator.js";
import { listMyCommunitiesV2 } from "../controllers/community.controller.js";

/**
 * V2 community routes — additive, mounted at `/api/v2/communities` beside the
 * frozen V1 `/api/v1/communities` router. Only `/mine` moves to the gap-safe
 * compound cursor here; every other community endpoint stays on V1.
 */
export const communityV2Routes: IRouter = Router();

communityV2Routes.use(authenticateAccessToken);

communityV2Routes.get(
  "/mine",
  validateQuery(myCommunitiesV2QuerySchema),
  listMyCommunitiesV2
);
