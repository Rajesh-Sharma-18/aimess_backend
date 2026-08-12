import { Router, type IRouter } from "express";

import { PERMISSIONS } from "../../constants/index.js";
import {
  disbandGroup,
  getGroupDetails,
  listGroupMembers,
  listGroups,
  removeGroupMember,
} from "../controllers/index.js";
import {
  adminAuth,
  requirePermission,
  validateBody,
  validateParams,
  validateQuery,
} from "../middleware/index.js";
import {
  disbandGroupSchema,
  groupIdParamSchema,
  groupMemberParamSchema,
  listGroupMembersQuerySchema,
  listGroupsQuerySchema,
  removeGroupMemberSchema,
} from "../validators/index.js";

/** Group Management admin API — self-prefixed at /v1/groups. */
export const groupRoutes: IRouter = Router();

// Every route requires a valid admin bearer.
groupRoutes.use(adminAuth);

// Read.
groupRoutes.get(
  "/groups",
  requirePermission(PERMISSIONS.GROUPS_READ),
  validateQuery(listGroupsQuerySchema),
  listGroups
);

groupRoutes.get(
  "/groups/:groupId",
  requirePermission(PERMISSIONS.GROUPS_READ),
  validateParams(groupIdParamSchema),
  getGroupDetails
);

groupRoutes.get(
  "/groups/:groupId/members",
  requirePermission(PERMISSIONS.GROUPS_READ),
  validateParams(groupIdParamSchema),
  validateQuery(listGroupMembersQuerySchema),
  listGroupMembers
);

// Moderate. Destructive lifecycle actions are POST /<resource>/:id/<verb>.
groupRoutes.post(
  "/groups/:groupId/disband",
  requirePermission(PERMISSIONS.GROUPS_MODERATE),
  validateParams(groupIdParamSchema),
  validateBody(disbandGroupSchema),
  disbandGroup
);

groupRoutes.post(
  "/groups/:groupId/members/:userId/remove",
  requirePermission(PERMISSIONS.GROUPS_MODERATE),
  validateParams(groupMemberParamSchema),
  validateBody(removeGroupMemberSchema),
  removeGroupMember
);
