import { Router, type IRouter } from "express";

import { PERMISSIONS } from "../../constants/index.js";
import {
  bulkCloseCommunities,
  bulkReopenCommunities,
  closeCommunity,
  getCommunityDetails,
  listCommunities,
  reopenCommunity,
} from "../controllers/index.js";
import {
  adminAuth,
  requirePermission,
  validateBody,
  validateParams,
  validateQuery,
} from "../middleware/index.js";
import {
  bulkCloseSchema,
  bulkReopenSchema,
  closeCommunitySchema,
  communityIdParamSchema,
  listCommunitiesQuerySchema,
  reopenCommunitySchema,
} from "../validators/index.js";

/** Community Management admin API — self-prefixed at /v1/communities. */
export const communityRoutes: IRouter = Router();

// Every route requires a valid admin bearer.
communityRoutes.use(adminAuth);

// Read.
communityRoutes.get(
  "/communities",
  requirePermission(PERMISSIONS.COMMUNITIES_READ),
  validateQuery(listCommunitiesQuerySchema),
  listCommunities
);

// Bulk actions — MUST be declared before the `/:communityId/*` routes so Express
// does not capture "bulk" as a communityId path param.
communityRoutes.post(
  "/communities/bulk/close",
  requirePermission(PERMISSIONS.COMMUNITIES_MODERATE),
  validateBody(bulkCloseSchema),
  bulkCloseCommunities
);
communityRoutes.post(
  "/communities/bulk/reopen",
  requirePermission(PERMISSIONS.COMMUNITIES_MODERATE),
  validateBody(bulkReopenSchema),
  bulkReopenCommunities
);

// Single-community detail + actions.
communityRoutes.get(
  "/communities/:communityId",
  requirePermission(PERMISSIONS.COMMUNITIES_READ),
  validateParams(communityIdParamSchema),
  getCommunityDetails
);
communityRoutes.post(
  "/communities/:communityId/close",
  requirePermission(PERMISSIONS.COMMUNITIES_MODERATE),
  validateParams(communityIdParamSchema),
  validateBody(closeCommunitySchema),
  closeCommunity
);
communityRoutes.post(
  "/communities/:communityId/reopen",
  requirePermission(PERMISSIONS.COMMUNITIES_MODERATE),
  validateParams(communityIdParamSchema),
  validateBody(reopenCommunitySchema),
  reopenCommunity
);
