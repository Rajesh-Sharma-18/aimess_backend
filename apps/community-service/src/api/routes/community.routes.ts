import { Router, type IRouter } from "express";

import {
  addCommunityMembers,
  banCommunityMember,
  checkHandleAvailable,
  checkNameAvailable,
  createCommunity,
  getCommunity,
  kickCommunityMember,
  leaveCommunity,
  listCategories,
  listCommunityAuditLogs,
  listCommunityMembers,
  listMyCommunities,
  unbanCommunityMember,
  updateCommunity,
  updateCommunityMemberRole,
} from "../controllers/community.controller.js";
import { createUploadUrl } from "../controllers/upload.controller.js";
import { validateBody } from "../middleware/validate-body.js";
import { validateParams } from "../middleware/validate-params.js";
import { validateQuery } from "../middleware/validate-query.js";
import { authenticateAccessToken } from "../../middleware/authenticate-access-token.js";
import {
  addMembersSchema,
  auditLogsQuerySchema,
  communityIdParamsSchema,
  communityMemberParamsSchema,
  createCommunitySchema,
  handleAvailableQuerySchema,
  listMembersQuerySchema,
  moderationReasonSchema,
  myCommunitiesQuerySchema,
  nameAvailableQuerySchema,
  updateCommunitySchema,
  updateMemberRoleSchema,
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

communityRoutes.get(
  "/:id/members",
  validateParams(communityIdParamsSchema),
  validateQuery(listMembersQuerySchema),
  listCommunityMembers
);

communityRoutes.get(
  "/:id/audit-logs",
  validateParams(communityIdParamsSchema),
  validateQuery(auditLogsQuerySchema),
  listCommunityAuditLogs
);

communityRoutes.post(
  "/:id/members",
  validateParams(communityIdParamsSchema),
  validateBody(addMembersSchema),
  addCommunityMembers
);

communityRoutes.post(
  "/:id/leave",
  validateParams(communityIdParamsSchema),
  leaveCommunity
);

communityRoutes.put(
  "/:id/members/:userId/role",
  validateParams(communityMemberParamsSchema),
  validateBody(updateMemberRoleSchema),
  updateCommunityMemberRole
);

communityRoutes.delete(
  "/:id/members/:userId",
  validateParams(communityMemberParamsSchema),
  validateBody(moderationReasonSchema),
  kickCommunityMember
);

communityRoutes.post(
  "/:id/members/:userId/ban",
  validateParams(communityMemberParamsSchema),
  validateBody(moderationReasonSchema),
  banCommunityMember
);

communityRoutes.delete(
  "/:id/members/:userId/ban",
  validateParams(communityMemberParamsSchema),
  unbanCommunityMember
);
