import { Router, type IRouter } from "express";

import { PERMISSIONS } from "../../constants/index.js";
import {
  banCommunityMember,
  unbanCommunityMember,
  bulkCloseCommunities,
  bulkReopenCommunities,
  closeCommunity,
  getCommunityConversationMessages,
  getCommunityDetails,
  listCommunities,
  listCommunityMembers,
  listCommunityMutedMembers,
  removeCommunityMember,
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
  communityMemberParamSchema,
  communityMessagesQuerySchema,
  listCommunitiesQuerySchema,
  listCommunityMembersQuerySchema,
  listMutedMembersQuerySchema,
  memberModerationSchema,
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
communityRoutes.get(
  "/communities/:communityId/members",
  requirePermission(PERMISSIONS.COMMUNITIES_READ),
  validateParams(communityIdParamSchema),
  validateQuery(listCommunityMembersQuerySchema),
  listCommunityMembers
);
communityRoutes.get(
  "/communities/:communityId/muted-members",
  requirePermission(PERMISSIONS.COMMUNITIES_READ),
  validateParams(communityIdParamSchema),
  validateQuery(listMutedMembersQuerySchema),
  listCommunityMutedMembers
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

// Community Conversation viewer — read-only message history + member
// moderation (remove/ban from THIS community). Gated the same as every
// other community-moderation route: COMMUNITIES_MODERATE.
communityRoutes.get(
  "/communities/:communityId/messages",
  requirePermission(PERMISSIONS.COMMUNITIES_MODERATE),
  validateParams(communityIdParamSchema),
  validateQuery(communityMessagesQuerySchema),
  getCommunityConversationMessages
);
communityRoutes.post(
  "/communities/:communityId/members/:userId/remove",
  requirePermission(PERMISSIONS.COMMUNITIES_MODERATE),
  validateParams(communityMemberParamSchema),
  validateBody(memberModerationSchema),
  removeCommunityMember
);
communityRoutes.post(
  "/communities/:communityId/members/:userId/ban",
  requirePermission(PERMISSIONS.COMMUNITIES_MODERATE),
  validateParams(communityMemberParamSchema),
  validateBody(memberModerationSchema),
  banCommunityMember
);
communityRoutes.post(
  "/communities/:communityId/members/:userId/unban",
  requirePermission(PERMISSIONS.COMMUNITIES_MODERATE),
  validateParams(communityMemberParamSchema),
  validateBody(memberModerationSchema),
  unbanCommunityMember
);
