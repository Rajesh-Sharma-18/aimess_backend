import { Router, type IRouter } from "express";

import {
  checkHandleAvailable,
  checkNameAvailable,
  createCommunity,
  getCommunity,
  listCategories,
  listMyCommunities,
  updateCommunity,
} from "../controllers/community.controller.js";
import { createUploadUrl } from "../controllers/upload.controller.js";
import { validateBody } from "../middleware/validate-body.js";
import { validateParams } from "../middleware/validate-params.js";
import { validateQuery } from "../middleware/validate-query.js";
import { authenticateAccessToken } from "../../middleware/authenticate-access-token.js";
import {
  communityIdParamsSchema,
  createCommunitySchema,
  handleAvailableQuerySchema,
  myCommunitiesQuerySchema,
  nameAvailableQuerySchema,
  updateCommunitySchema,
} from "../validators/community.validator.js";
import { uploadUrlSchema } from "../validators/upload.validator.js";

export const communityRoutes: IRouter = Router();

// All community endpoints require a valid access token.
communityRoutes.use(authenticateAccessToken);

// Static / specific routes MUST be registered before the `/:id` param route.
communityRoutes.get("/categories", listCategories);

communityRoutes.get(
  "/name-available",
  validateQuery(nameAvailableQuerySchema),
  checkNameAvailable
);

communityRoutes.get(
  "/handle-available",
  validateQuery(handleAvailableQuerySchema),
  checkHandleAvailable
);

communityRoutes.get(
  "/mine",
  validateQuery(myCommunitiesQuerySchema),
  listMyCommunities
);

communityRoutes.post(
  "/uploads/url",
  validateBody(uploadUrlSchema),
  createUploadUrl
);

communityRoutes.post("/", validateBody(createCommunitySchema), createCommunity);

communityRoutes.get(
  "/:id",
  validateParams(communityIdParamsSchema),
  getCommunity
);

communityRoutes.patch(
  "/:id",
  validateParams(communityIdParamsSchema),
  validateBody(updateCommunitySchema),
  updateCommunity
);
